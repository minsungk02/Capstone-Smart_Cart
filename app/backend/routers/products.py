"""Product registration endpoints.

Reuses checkout_core embedding functions to add new products
to the FAISS index, mirroring pages/1_Add_Product.py logic.
"""

from __future__ import annotations

import logging
import os
from io import BytesIO
from typing import Annotated

import cv2
import faiss
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from PIL import Image
from sqlalchemy import inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend import config
from backend.database import get_db
from backend.dependencies import app_state

logger = logging.getLogger("backend.products")

router = APIRouter(tags=["products"])

DINO_WEIGHT = 0.7
CLIP_WEIGHT = 0.3
MIN_IMAGES = 3
MAX_IMAGES = 10
STOCK_COLUMN_CANDIDATES = ("stock", "stock_qty", "inventory", "quantity", "qty")


class ProductDetailUpdate(BaseModel):
    product_name: str | None = None
    barcd: str | None = None
    price: int | None = None
    stock: int | None = None
    is_discounted: bool | None = None
    discount_rate: float | None = None
    discount_amount: int | None = None


def _table_columns(db: Session, table_name: str) -> set[str]:
    try:
        db_inspector = inspect(db.get_bind())
        return {
            str(col.get("name"))
            for col in db_inspector.get_columns(table_name)
            if col.get("name")
        }
    except Exception:
        return set()


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        db_inspector = inspect(db.get_bind())
        return bool(db_inspector.has_table(table_name))
    except Exception:
        return False


def _pick_stock_column(product_columns: set[str]) -> str | None:
    for col in STOCK_COLUMN_CANDIDATES:
        if col in product_columns:
            return col
    return None


def _latest_discount_row(
    db: Session,
    product_price_id: int,
    discount_columns: set[str],
) -> dict[str, object] | None:
    if "product_price_id" not in discount_columns:
        return None

    select_cols = [
        c
        for c in (
            "id",
            "is_discounted",
            "discount_rate",
            "discount_amount",
            "started_at",
            "ended_at",
            "updated_at",
            "created_at",
        )
        if c in discount_columns
    ]
    if not select_cols:
        return None

    order_cols = [c for c in ("updated_at", "created_at", "id") if c in discount_columns]
    if not order_cols:
        order_cols = [select_cols[0]]

    sql = (
        f"SELECT {', '.join(f'`{col}`' for col in select_cols)} "
        "FROM product_discounts "
        "WHERE `product_price_id` = :ppid "
        f"ORDER BY {', '.join(f'`{col}` DESC' for col in order_cols)} "
        "LIMIT 1"
    )

    row = db.execute(text(sql), {"ppid": int(product_price_id)}).mappings().first()
    return dict(row) if row else None


def _insert_discount_row(
    db: Session,
    product_price_id: int,
    payload: ProductDetailUpdate,
    discount_columns: set[str],
) -> None:
    if "product_price_id" not in discount_columns:
        raise HTTPException(status_code=422, detail="product_discounts schema missing product_price_id")

    discount_rate = None
    if payload.discount_rate is not None:
        if payload.discount_rate < 0:
            raise HTTPException(status_code=422, detail="discount_rate must be >= 0")
        discount_rate = float(payload.discount_rate)

    discount_amount = None
    if payload.discount_amount is not None:
        if payload.discount_amount < 0:
            raise HTTPException(status_code=422, detail="discount_amount must be >= 0")
        discount_amount = int(payload.discount_amount)

    if payload.is_discounted is not None:
        is_discounted_value = 1 if payload.is_discounted else 0
    else:
        is_discounted_value = 1 if (discount_rate or 0) > 0 or (discount_amount or 0) > 0 else 0

    values: dict[str, object] = {"product_price_id": int(product_price_id)}
    if "is_discounted" in discount_columns:
        values["is_discounted"] = is_discounted_value
    if "discount_rate" in discount_columns:
        values["discount_rate"] = discount_rate
    if "discount_amount" in discount_columns:
        values["discount_amount"] = discount_amount

    cols: list[str] = []
    exprs: list[str] = []
    params: dict[str, object] = {}

    for col, value in values.items():
        cols.append(f"`{col}`")
        key = f"v_{col}"
        exprs.append(f":{key}")
        params[key] = value

    if "created_at" in discount_columns:
        cols.append("`created_at`")
        exprs.append("CURRENT_TIMESTAMP")
    if "updated_at" in discount_columns:
        cols.append("`updated_at`")
        exprs.append("CURRENT_TIMESTAMP")

    sql = (
        f"INSERT INTO product_discounts ({', '.join(cols)}) "
        f"VALUES ({', '.join(exprs)})"
    )
    db.execute(text(sql), params)


def _pil_to_bgr(img: Image.Image) -> np.ndarray:
    """Convert PIL RGB image to OpenCV BGR ndarray."""
    rgb = np.array(img.convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _build_raw_embedding(image_bgr: np.ndarray) -> np.ndarray:
    """Build raw concatenated [DINO, CLIP] embedding for a single image."""
    from checkout_core.inference import extract_clip_embedding, extract_dino_embedding

    bundle = app_state.model_bundle
    dino_emb = extract_dino_embedding(
        image_bgr, bundle["dino_model"], bundle["dino_processor"], bundle["device"]
    )
    clip_emb = extract_clip_embedding(
        image_bgr, bundle["clip_model"], bundle["clip_processor"], bundle["device"]
    )
    return np.concatenate([dino_emb, clip_emb], axis=0)


def _build_weighted(raw: np.ndarray, dino_dim: int, clip_dim: int) -> np.ndarray:
    """Apply DINO/CLIP weighting and L2-normalize."""
    weighted = raw.copy().astype(np.float32)
    weighted[:dino_dim] *= DINO_WEIGHT
    weighted[dino_dim:] *= CLIP_WEIGHT
    norm = np.linalg.norm(weighted)
    if norm > 0:
        weighted /= norm
    return weighted


def _recompute_weighted_db(embeddings: np.ndarray, dino_dim: int, clip_dim: int) -> np.ndarray:
    if embeddings.size == 0:
        return np.empty((0, dino_dim + clip_dim), dtype=np.float32)

    dino = embeddings[:, :dino_dim].astype(np.float32)
    clip = embeddings[:, dino_dim : dino_dim + clip_dim].astype(np.float32)

    def _normalize_rows(matrix: np.ndarray) -> np.ndarray:
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        return matrix / np.maximum(norms, 1e-12)

    dino = _normalize_rows(dino)
    clip = _normalize_rows(clip)
    weighted = np.concatenate([dino * DINO_WEIGHT, clip * CLIP_WEIGHT], axis=1).astype(
        np.float32
    )
    weighted = _normalize_rows(weighted)
    return weighted


@router.post("/products")
async def add_product(
    item_no: Annotated[str, Form()],
    name: Annotated[str, Form()],
    price: Annotated[int, Form()],
    barcd: Annotated[str | None, Form()] = None,
    images: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    """Register a new product with 3-10 images."""
    if not item_no.strip():
        raise HTTPException(status_code=422, detail="Item number is required")
    if not name.strip():
        raise HTTPException(status_code=422, detail="Product name is required")
    if price <= 0:
        raise HTTPException(status_code=422, detail="Price must be positive")
    if len(images) < MIN_IMAGES or len(images) > MAX_IMAGES:
        raise HTTPException(
            status_code=422,
            detail=f"Provide at least {MIN_IMAGES} images (up to {MAX_IMAGES})",
        )

    bundle = app_state.model_bundle
    dino_dim = bundle["dino_dim"]
    clip_dim = bundle["clip_dim"]

    new_raw_list: list[np.ndarray] = []
    for upload in images:
        data = await upload.read()
        try:
            img = Image.open(BytesIO(data)).convert("RGB")
        except Exception:
            raise HTTPException(status_code=422, detail=f"Invalid image: {upload.filename}")
        bgr = _pil_to_bgr(img)
        raw_emb = _build_raw_embedding(bgr)
        new_raw_list.append(raw_emb)

    new_raw = np.stack(new_raw_list, axis=0).astype(np.float32)
    clean_name = name.strip()
    clean_item_no = item_no.strip()
    clean_barcd = barcd.strip() if barcd and barcd.strip() else None
    label = f"{clean_item_no}_{clean_name}"
    new_labels = np.array([label] * len(new_raw_list), dtype=object)

    weighted_new = np.stack(
        [_build_weighted(r, dino_dim, clip_dim) for r in new_raw_list],
        axis=0,
    ).astype(np.float32)

    product_id: int | None = None
    try:
        existing = db.execute(
            text(
                """
                SELECT id FROM products
                WHERE item_no = :item_no
                ORDER BY id DESC
                LIMIT 1
                """
            ),
            {"item_no": clean_item_no},
        ).mappings().first()
        if existing:
            product_id = int(existing["id"])
            db.execute(
                text(
                    """
                    UPDATE products
                    SET product_name = :name, barcd = :barcd, updated_at = CURRENT_TIMESTAMP
                    WHERE id = :id
                    """
                ),
                {"name": clean_name, "barcd": clean_barcd, "id": product_id},
            )
        else:
            result = db.execute(
                text(
                    """
                    INSERT INTO products (item_no, barcd, product_name, created_at, updated_at)
                    VALUES (:item_no, :barcd, :name, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """
                ),
                {"item_no": clean_item_no, "barcd": clean_barcd, "name": clean_name},
            )
            product_id = int(result.lastrowid or 0)
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"DB error: {exc}") from exc

    if not product_id:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to create product record")

    async with app_state.index_rwlock.writer_lock:
        if os.path.exists(config.EMBEDDINGS_PATH) and os.path.exists(config.LABELS_PATH):
            old_emb = np.load(config.EMBEDDINGS_PATH, allow_pickle=False)
            old_lbl = np.load(config.LABELS_PATH, allow_pickle=True)
            updated_emb = np.vstack([old_emb, new_raw])
            updated_lbl = np.concatenate([old_lbl, new_labels])
        else:
            updated_emb = new_raw
            updated_lbl = new_labels

        np.save(config.EMBEDDINGS_PATH, updated_emb)
        np.save(config.LABELS_PATH, updated_lbl)

        if app_state.faiss_index is None or app_state.faiss_index.ntotal == 0:
            dim = weighted_new.shape[1]
            app_state.faiss_index = faiss.IndexFlatIP(dim)

        app_state.faiss_index.add(weighted_new)
        faiss.write_index(app_state.faiss_index, config.FAISS_INDEX_PATH)

        if app_state.weighted_db is None or len(app_state.weighted_db) == 0:
            app_state.weighted_db = weighted_new
        else:
            app_state.weighted_db = np.vstack([app_state.weighted_db, weighted_new])

        app_state.labels = updated_lbl

    try:
        db.execute(
            text(
                """
                INSERT INTO product_prices (product_id, price, currency, source, checked_at, created_at)
                VALUES (:product_id, :price, 'KRW', 'admin_upload', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """
            ),
            {"product_id": product_id, "price": int(price)},
        )
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"DB error: {exc}") from exc

    return {
        "status": "added",
        "item_no": clean_item_no,
        "product_name": clean_name,
        "total_products": len(set(updated_lbl)),
        "total_embeddings": len(updated_lbl),
    }


@router.get("/products")
async def list_products(
    skip: int = 0, 
    limit: int = 24, 
    db: Session = Depends(get_db)
):
    """List products with pagination (SQL Error Fixed version).[cite: 9]"""
    labels = app_state.labels
    embedding_total = int(len(labels)) if labels is not None else 0
    label_counts: dict[str, int] = {}
    embed_products: dict[str, dict[str, object]] = {}
    
    if labels is not None:
        for lbl in labels:
            label_str = str(lbl)
            label_counts[label_str] = label_counts.get(label_str, 0) + 1

        for label_str, count in label_counts.items():
            item_no = None
            name = label_str
            if "_" in label_str:
                prefix, suffix = label_str.split("_", 1)
                if prefix.isdigit():
                    item_no = prefix
                    name = suffix or label_str

            key = item_no if item_no else f"__name__:{name}"
            if key in embed_products:
                embed_products[key]["embedding_count"] = int(
                    embed_products[key]["embedding_count"]
                ) + int(count)
            else:
                embed_products[key] = {
                    "item_no": item_no,
                    "name": name,
                    "embedding_count": int(count),
                }

    try:
        db_total_count_row = db.execute(text("SELECT COUNT(DISTINCT item_no) as cnt FROM products")).mappings().first()
        db_total_count = db_total_count_row["cnt"] if db_total_count_row else 0

        # Fixed SQL: INNER JOIN with subquery to avoid ONLY_FULL_GROUP_BY issues[cite: 9]
        rows = db.execute(
            text(
                """
                SELECT p.id, p.item_no, p.barcd, p.product_name
                FROM products p
                INNER JOIN (
                    SELECT MAX(id) as max_id
                    FROM products
                    GROUP BY item_no
                ) sub ON p.id = sub.max_id
                ORDER BY p.id DESC
                LIMIT :limit OFFSET :skip
                """
            ),
            {"limit": limit, "skip": skip}
        ).mappings().all()
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail=f"DB error: {exc}") from exc

    products = []
    seen_item_nos: set[str] = set()
    for row in rows:
        item_no = str(row["item_no"])
        if item_no in seen_item_nos:
            continue
        seen_item_nos.add(item_no)

        name = str(row["product_name"])
        embedding_key = item_no
        embedding_count = 0
        if embedding_key in embed_products:
            embedding_count = int(embed_products[embedding_key]["embedding_count"])
            embed_products.pop(embedding_key, None)
        else:
            label = f"{item_no}_{name}"
            embedding_count = label_counts.get(label, 0)

        price_row = db.execute(
            text(
                """
                SELECT price
                FROM product_prices
                WHERE product_id = :pid
                ORDER BY checked_at DESC, id DESC
                LIMIT 1
                """
            ),
            {"pid": row["id"]},
        ).mappings().first()
        price = int(price_row["price"]) if price_row else None

        products.append(
            {
                "id": int(row["id"]),
                "item_no": item_no,
                "name": name,
                "price": price,
                "barcd": row.get("barcd"),
                "label": f"{item_no}_{name}",
                "embedding_count": int(embedding_count),
            }
        )

    embed_only_keys = sorted(embed_products.keys())
    if len(products) < limit:
        remaining_slots = limit - len(products)
        embed_skip = max(0, skip - db_total_count)
        target_keys = embed_only_keys[embed_skip : embed_skip + remaining_slots]
        
        for key in target_keys:
            entry = embed_products[key]
            item_no = entry.get("item_no")
            name = entry.get("name")
            products.append(
                {
                    "id": None,
                    "item_no": item_no or "",
                    "name": str(name),
                    "price": None,
                    "barcd": None,
                    "label": f"{item_no}_{name}" if item_no else str(name),
                    "embedding_count": int(entry.get("embedding_count") or 0),
                }
            )

    total_combined = db_total_count + len(embed_only_keys)
    return {
        "products": products,
        "total_embeddings": embedding_total,
        "total_count": total_combined,
        "has_more": skip + limit < total_combined
    }


@router.get("/products/{item_no}/detail")
async def get_product_detail(item_no: str, db: Session = Depends(get_db)):
    clean_item_no = (item_no or "").strip()
    if not clean_item_no:
        raise HTTPException(status_code=422, detail="Item number is required")

    product_row = db.execute(
        text("SELECT * FROM products WHERE item_no = :it ORDER BY id DESC LIMIT 1"),
        {"it": clean_item_no},
    ).mappings().first()
    if not product_row:
        raise HTTPException(status_code=404, detail="Product not found")

    product = dict(product_row)
    p_columns = _table_columns(db, "products")
    s_col = _pick_stock_column(p_columns)
    
    price_row = db.execute(
        text(
            """
            SELECT id, price, currency, source, checked_at
            FROM product_prices
            WHERE product_id = :pid
            ORDER BY checked_at DESC, id DESC
            LIMIT 1
            """
        ),
        {"pid": int(product["id"])},
    ).mappings().first()
    price = dict(price_row) if price_row else {}

    discount_available = _table_exists(db, "product_discounts")
    return {
        "id": int(product["id"]),
        "item_no": str(product.get("item_no") or ""),
        "product_name": str(product.get("product_name") or ""),
        "barcd": product.get("barcd"),
        "stock": int(product.get(s_col)) if s_col and product.get(s_col) is not None else None,
        "price": int(price["price"]) if price.get("price") is not None else None,
        "available_fields": {
            "stock": s_col is not None,
            "discount": discount_available,
        },
    }


@router.put("/products/{item_no}/detail")
async def update_product_detail(
    item_no: str,
    payload: ProductDetailUpdate,
    db: Session = Depends(get_db),
):
    clean_item_no = (item_no or "").strip()
    product_row = db.execute(
        text("SELECT id FROM products WHERE item_no = :it ORDER BY id DESC LIMIT 1"),
        {"it": clean_item_no},
    ).mappings().first()
    if not product_row:
        raise HTTPException(status_code=404, detail="Product not found")

    product_id = int(product_row["id"])
    s_col = _pick_stock_column(_table_columns(db, "products"))

    updates, params = [], {"id": product_id}
    if payload.product_name:
        updates.append("`product_name` = :nm"); params["nm"] = payload.product_name.strip()
    if payload.barcd is not None:
        updates.append("`barcd` = :bc"); params["bc"] = payload.barcd.strip() or None
    if payload.stock is not None and s_col:
        updates.append(f"`{s_col}` = :st"); params["st"] = int(payload.stock)

    if updates:
        db.execute(text(f"UPDATE products SET {', '.join(updates)}, updated_at = CURRENT_TIMESTAMP WHERE id = :id"), params)

    l_pr_row = db.execute(
        text("SELECT id, price, currency FROM product_prices WHERE product_id = :pid ORDER BY checked_at DESC, id DESC LIMIT 1"),
        {"pid": product_id},
    ).mappings().first()
    l_pr_id = int(l_pr_row["id"]) if l_pr_row else None

    if payload.price is not None:
        res = db.execute(
            text(
                """
                INSERT INTO product_prices (product_id, price, currency, source, checked_at, created_at)
                VALUES (:pid, :pr, :cu, 'admin_edit', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """
            ),
            {"pid": product_id, "pr": int(payload.price), "cu": str(l_pr_row.get("currency", "KRW") if l_pr_row else "KRW")},
        )
        l_pr_id = int(res.lastrowid or 0) or l_pr_id

    if (payload.is_discounted is not None or payload.discount_rate is not None or payload.discount_amount is not None) and l_pr_id:
        _insert_discount_row(db, l_pr_id, payload, _table_columns(db, "product_discounts"))

    db.commit()
    return {"status": "updated", "item_no": clean_item_no}


@router.delete("/products/{item_no}")
async def delete_product(item_no: str, db: Session = Depends(get_db)):
    clean_item_no = (item_no or "").strip()
    rows = db.execute(
        text("SELECT id, product_name FROM products WHERE item_no = :it"),
        {"it": clean_item_no}
    ).mappings().all()
    if not rows:
        raise HTTPException(status_code=404, detail="Product not found")

    p_ids = [int(r["id"]) for r in rows]
    p_names = {str(r["product_name"]) for r in rows if r.get("product_name")}

    rem_emb = 0
    async with app_state.index_rwlock.writer_lock:
        if os.path.exists(config.EMBEDDINGS_PATH) and os.path.exists(config.LABELS_PATH):
            emb, lbl = np.load(config.EMBEDDINGS_PATH), np.load(config.LABELS_PATH, allow_pickle=True)
            keep = np.array([not (str(l).startswith(f"{clean_item_no}_") or str(l) in p_names) for l in lbl], dtype=bool)
            rem_emb = int((~keep).sum())
            np.save(config.EMBEDDINGS_PATH, emb[keep]); np.save(config.LABELS_PATH, lbl[keep])
            app_state.weighted_db = _recompute_weighted_db(emb[keep], app_state.model_bundle["dino_dim"], app_state.model_bundle["clip_dim"])
            app_state.labels = lbl[keep]
            from checkout_core.inference import build_or_load_index
            app_state.faiss_index = build_or_load_index(app_state.weighted_db, config.FAISS_INDEX_PATH)

    for pid in p_ids:
        db.execute(text("DELETE FROM product_prices WHERE product_id = :pid"), {"pid": pid})
    db.execute(text("DELETE FROM products WHERE item_no = :it"), {"it": clean_item_no})
    db.commit()
    return {"status": "deleted", "item_no": clean_item_no, "removed_embeddings": rem_emb}