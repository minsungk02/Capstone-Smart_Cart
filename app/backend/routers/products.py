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
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, Depends
from fastapi.responses import JSONResponse
from PIL import Image
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend import config
from backend.dependencies import app_state
from backend.database import get_db

logger = logging.getLogger("backend.products")

router = APIRouter(tags=["products"])

DINO_WEIGHT = 0.7
CLIP_WEIGHT = 0.3
MIN_IMAGES = 3
MAX_IMAGES = 5


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


def _rebuild_index_from_raw(
    raw_embeddings: np.ndarray | None,
    labels: np.ndarray | None,
    dino_dim: int,
    clip_dim: int,
) -> None:
    """Rebuild FAISS index and in-memory cache from raw embeddings."""
    if raw_embeddings is None or labels is None or len(labels) == 0:
        app_state.faiss_index = None
        app_state.weighted_db = None
        app_state.labels = np.array([], dtype=np.str_)
        if os.path.exists(config.FAISS_INDEX_PATH):
            os.remove(config.FAISS_INDEX_PATH)
        return

    weighted_db = np.stack(
        [_build_weighted(r, dino_dim, clip_dim) for r in raw_embeddings], axis=0
    ).astype(np.float32)
    dim = weighted_db.shape[1]
    index = faiss.IndexFlatIP(dim)
    index.add(weighted_db)
    faiss.write_index(index, config.FAISS_INDEX_PATH)
    app_state.faiss_index = index
    app_state.weighted_db = weighted_db
    app_state.labels = labels


def _remove_embeddings_for_item_no(item_no: str) -> int:
    """Remove embeddings for a given item_no and rebuild index."""
    if not os.path.exists(config.LABELS_PATH) or not os.path.exists(config.EMBEDDINGS_PATH):
        return 0

    labels = np.load(config.LABELS_PATH, allow_pickle=True).astype(str)
    emb = np.load(config.EMBEDDINGS_PATH, allow_pickle=False)
    mask = np.array([not str(lbl).startswith(f"{item_no}_") for lbl in labels])
    removed = int(len(labels) - int(mask.sum()))
    new_labels = labels[mask]
    new_emb = emb[mask]

    np.save(config.LABELS_PATH, new_labels)
    np.save(config.EMBEDDINGS_PATH, new_emb)

    bundle = app_state.model_bundle
    _rebuild_index_from_raw(new_emb, new_labels, bundle["dino_dim"], bundle["clip_dim"])
    return removed

# 상품 삭제 엔드포인트
@router.delete("/products/{item_no}")
async def delete_product(item_no: str, db: Session = Depends(get_db)):
    """Delete a product and its embeddings by item_no."""
    item_no = item_no.strip()
    if not item_no:
        raise HTTPException(status_code=422, detail="item_no is required")

    try:
        db.execute(
            text(
                "DELETE FROM product_prices WHERE product_id IN "
                "(SELECT id FROM products WHERE item_no = :item_no)"
            ),
            {"item_no": item_no},
        )
        result = db.execute(
            text("DELETE FROM products WHERE item_no = :item_no"),
            {"item_no": item_no},
        )
        db.commit()
        deleted_rows = int(result.rowcount or 0)
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to delete product from DB") from exc

    async with app_state.index_rwlock.writer_lock:
        removed_embeddings = _remove_embeddings_for_item_no(item_no)
    return {
        "status": "deleted",
        "deleted_rows": deleted_rows,
        "removed_embeddings": removed_embeddings,
    }

@router.post("/products")
async def add_product(
    item_no: Annotated[str, Form()],
    name: Annotated[str, Form()],
    price: Annotated[int, Form()],
    barcd: Annotated[str | None, Form()] = None,
    images: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    """Register a new product with 3-5 images.

    Generates embeddings, appends to DB files, and updates the FAISS index.
    """
    item_no = item_no.strip()
    name = name.strip()
    barcd = barcd.strip() if isinstance(barcd, str) else None
    if barcd == "":
        barcd = None

    if not item_no:
        raise HTTPException(status_code=422, detail="item_no is required")
    if not name:
        raise HTTPException(status_code=422, detail="Product name is required")
    if price <= 0:
        raise HTTPException(status_code=422, detail="Price must be a positive integer")
    if len(images) < MIN_IMAGES or len(images) > MAX_IMAGES:
        raise HTTPException(
            status_code=422,
            detail=f"Provide {MIN_IMAGES}-{MAX_IMAGES} images",
        )

    bundle = app_state.model_bundle
    dino_dim = bundle["dino_dim"]
    clip_dim = bundle["clip_dim"]

    # Generate raw embeddings for each image
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
    # 라벨을 'item_no_name' 형태로 저장
    label_value = f"{item_no}_{name}"
    new_labels = np.array([label_value] * len(new_raw_list), dtype=object)

    # Build weighted embeddings for new images BEFORE acquiring lock
    weighted_new = np.stack(
        [_build_weighted(r, dino_dim, clip_dim) for r in new_raw_list],
        axis=0,
    ).astype(np.float32)

    # Acquire writer lock: blocks all inference requests until update completes
    async with app_state.index_rwlock.writer_lock:
        old_emb = None
        old_lbl = None
        if os.path.exists(config.EMBEDDINGS_PATH) and os.path.exists(config.LABELS_PATH):
            old_emb = np.load(config.EMBEDDINGS_PATH, allow_pickle=False)
            old_lbl = np.load(config.LABELS_PATH, allow_pickle=True)
            updated_emb = np.vstack([old_emb, new_raw])
            updated_lbl = np.concatenate([old_lbl, new_labels])
        else:
            updated_emb = new_raw
            updated_lbl = new_labels

        try:
            np.save(config.EMBEDDINGS_PATH, updated_emb)
            np.save(config.LABELS_PATH, updated_lbl)

            if app_state.faiss_index is None or app_state.faiss_index.ntotal == 0:
                weighted_db = np.stack(
                    [_build_weighted(r, dino_dim, clip_dim) for r in updated_emb],
                    axis=0,
                ).astype(np.float32)
                dim = weighted_db.shape[1]
                app_state.faiss_index = faiss.IndexFlatIP(dim)
                app_state.faiss_index.add(weighted_db)
                app_state.weighted_db = weighted_db
            else:
                app_state.faiss_index.add(weighted_new)
                if app_state.weighted_db is None or len(app_state.weighted_db) == 0:
                    app_state.weighted_db = weighted_new
                else:
                    app_state.weighted_db = np.vstack([app_state.weighted_db, weighted_new])

            faiss.write_index(app_state.faiss_index, config.FAISS_INDEX_PATH)

            app_state.labels = updated_lbl
        except Exception as exc:
            logger.exception("Failed to update embedding DB: %s", exc)
            raise HTTPException(status_code=500, detail="Failed to update embeddings") from exc

        try:
            existing = db.execute(
                text(
                    "SELECT id FROM products WHERE item_no = :item_no ORDER BY id DESC LIMIT 1"
                ),
                {"item_no": item_no},
            ).mappings().first()

            if existing:
                product_id = int(existing["id"])
                db.execute(
                    text(
                        "UPDATE products SET product_name = :name, barcd = :barcd, "
                        "updated_at = CURRENT_TIMESTAMP WHERE id = :id"
                    ),
                    {"name": name, "barcd": barcd, "id": product_id},
                )
            else:
                db.execute(
                    text(
                        "INSERT INTO products (item_no, barcd, product_name) "
                        "VALUES (:item_no, :barcd, :name)"
                    ),
                    {"item_no": item_no, "barcd": barcd, "name": name},
                )
                created = db.execute(
                    text(
                        "SELECT id FROM products WHERE item_no = :item_no "
                        "ORDER BY id DESC LIMIT 1"
                    ),
                    {"item_no": item_no},
                ).mappings().first()
                if not created:
                    raise SQLAlchemyError("Failed to fetch inserted product id")
                product_id = int(created["id"])

            db.execute(
                text("INSERT INTO product_prices (product_id, price) VALUES (:pid, :price)"),
                {"pid": product_id, "price": int(price)},
            )
            db.commit()
        except SQLAlchemyError as exc:
            db.rollback()
            # Restore embedding state on DB failure
            if old_emb is None or old_lbl is None:
                if os.path.exists(config.EMBEDDINGS_PATH):
                    os.remove(config.EMBEDDINGS_PATH)
                if os.path.exists(config.LABELS_PATH):
                    os.remove(config.LABELS_PATH)
                app_state.faiss_index = None
                app_state.weighted_db = None
                app_state.labels = np.array([], dtype=np.str_)
                if os.path.exists(config.FAISS_INDEX_PATH):
                    os.remove(config.FAISS_INDEX_PATH)
            else:
                np.save(config.EMBEDDINGS_PATH, old_emb)
                np.save(config.LABELS_PATH, old_lbl)
                _rebuild_index_from_raw(old_emb, old_lbl, dino_dim, clip_dim)
            raise HTTPException(status_code=500, detail="Failed to write product to DB") from exc

    logger.info(
        "Product '%s' added (%d images, total DB: %d)", name, len(images), len(updated_lbl)
    )

    return JSONResponse(
        content={
            "status": "added",
            "item_no": item_no,
            "product_name": name,
            "label": label_value,
            "price": int(price),
            "images_count": len(images),
            "total_products": len(set(updated_lbl)),
            "total_embeddings": len(updated_lbl),
        },
        media_type="application/json; charset=utf-8"
    )


@router.get("/products")
async def list_products():
    """List all registered products with their embedding counts."""
    labels = app_state.labels
    if labels is None or len(labels) == 0:
        return JSONResponse(
            content={"products": [], "total_embeddings": 0},
            media_type="application/json; charset=utf-8"
        )

    product_counts: dict[str, dict[str, object]] = {}
    for lbl in labels:
        label = str(lbl)
        # 'item_no_name'에서 name만 추출
        if "_" in label:
            item_no, name = label.split("_", 1)
        else:
            item_no, name = label, label
        entry = product_counts.get(item_no)
        if not entry:
            entry = {"item_no": item_no, "name": name, "embedding_count": 0}
            product_counts[item_no] = entry
        entry["embedding_count"] = int(entry["embedding_count"]) + 1

    products = [
        entry for entry in sorted(product_counts.values(), key=lambda x: str(x["name"]))
    ]
    return JSONResponse(
        content={
            "products": products,
            "total_embeddings": int(len(labels)),
        },
        media_type="application/json; charset=utf-8"
    )
