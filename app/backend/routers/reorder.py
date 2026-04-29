"""Reorder (자동 발주) endpoints."""

from __future__ import annotations

import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.routers.auth import get_current_user

router = APIRouter(prefix="/reorder", tags=["reorder"])


class ReorderItem(BaseModel):
    product_name: str
    item_no: str | None = None
    quantity: int
    unit_price: int | None = None


class ReorderCreate(BaseModel):
    items: List[ReorderItem]
    notes: str | None = None


class ReorderResponse(BaseModel):
    id: int
    admin_id: int
    admin_name: str
    items: list
    total_quantity: int
    total_amount: int
    status: str
    notes: str | None
    created_at: str
    updated_at: str


class ReorderStatusUpdate(BaseModel):
    status: str


STATUS_TRANSITIONS: dict[str, list[str]] = {
    "pending":   ["ordered", "cancelled"],
    "ordered":   ["received", "cancelled"],
    "received":  [],
    "cancelled": [],
}

STATUS_LABELS: dict[str, str] = {
    "pending":   "발주 대기",
    "ordered":   "발주 완료",
    "received":  "입고 완료",
    "cancelled": "취소됨",
}


def _ensure_reorder_table(db: Session) -> None:
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS reorder_history (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            admin_id     INT NOT NULL,
            items        JSON NOT NULL,
            status       VARCHAR(20) NOT NULL DEFAULT 'pending',
            notes        TEXT,
            created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """))
    db.commit()


def _row_to_response(row: dict, admin_name: str) -> ReorderResponse:
    raw = row.get("items", [])
    if isinstance(raw, str):
        try:
            items = json.loads(raw)
        except Exception:
            items = []
    elif isinstance(raw, list):
        items = raw
    else:
        items = []

    total_quantity = sum(int(i.get("quantity", 0)) for i in items)
    total_amount = sum(
        int(i.get("quantity", 0)) * int(i.get("unit_price") or 0)
        for i in items
    )
    return ReorderResponse(
        id=int(row["id"]),
        admin_id=int(row["admin_id"]),
        admin_name=admin_name,
        items=items,
        total_quantity=total_quantity,
        total_amount=total_amount,
        status=str(row["status"]),
        notes=row.get("notes"),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _get_admin_name(db: Session, admin_id: int) -> str:
    row = db.execute(
        text("SELECT name, username FROM users WHERE id = :id"),
        {"id": admin_id},
    ).mappings().first()
    if row:
        return str(row.get("name") or row.get("username") or "관리자")
    return "관리자"


@router.get("/suggestions")
async def get_reorder_suggestions(
    limit: int = 10,
    sort: str = "best_seller",
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="관리자만 접근 가능합니다.")

    all_purchases = db.query(models.PurchaseHistory.items).all()
    product_counts: dict[str, int] = {}
    for purchase in all_purchases:
        items = purchase.items if isinstance(purchase.items, list) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            try:
                count = int(item.get("count", 0))
            except (TypeError, ValueError):
                count = 0
            if count > 0:
                product_counts[name] = product_counts.get(name, 0) + count

    rows = db.execute(
        text("""
            SELECT p.item_no, p.product_name, p.stock, pp.price
            FROM products p
            LEFT JOIN product_prices pp ON pp.product_id = p.id
            ORDER BY pp.checked_at DESC, pp.id DESC
        """)
    ).mappings().all()

    seen = set()
    product_db_map: dict[str, dict] = {}
    for row in rows:
        name = str(row["product_name"])
        if name not in seen:
            seen.add(name)
            product_db_map[name] = dict(row)

    if sort == "low_stock":
        candidates = []
        for name, db_row in product_db_map.items():
            stock = int(db_row.get("stock") or 0)
            total_sold = product_counts.get(name, 0)
            suggested_qty = max(1, round(total_sold * 0.5)) if total_sold > 0 else 10
            candidates.append({
                "product_name": name,
                "item_no": str(db_row["item_no"]) if db_row.get("item_no") else None,
                "total_sold": total_sold,
                "current_stock": stock,
                "suggested_quantity": suggested_qty,
                "unit_price": int(db_row["price"]) if db_row.get("price") else None,
            })
        candidates.sort(key=lambda x: (x["current_stock"], -x["total_sold"]))
        return candidates[:limit]

    else:
        sorted_products = sorted(product_counts.items(), key=lambda x: x[1], reverse=True)[:limit]
        suggestions = []
        for product_name, total_sold in sorted_products:
            db_row = product_db_map.get(product_name)
            item_no = str(db_row["item_no"]) if db_row and db_row.get("item_no") else None
            price = int(db_row["price"]) if db_row and db_row.get("price") else None
            stock = int(db_row.get("stock") or 0) if db_row else 0
            suggested_qty = max(1, round(total_sold * 0.5))
            suggestions.append({
                "product_name": product_name,
                "item_no": item_no,
                "total_sold": total_sold,
                "current_stock": stock,
                "suggested_quantity": suggested_qty,
                "unit_price": price,
            })
        return suggestions


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ReorderResponse)
async def create_reorder(
    payload: ReorderCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="관리자만 접근 가능합니다.")
    if not payload.items:
        raise HTTPException(status_code=422, detail="발주 항목이 없습니다.")

    _ensure_reorder_table(db)

    items_json = json.dumps(
        [item.model_dump() for item in payload.items],
        ensure_ascii=False,
    )

    try:
        result = db.execute(
            text("""
                INSERT INTO reorder_history (admin_id, items, status, notes, created_at, updated_at)
                VALUES (:admin_id, :items, 'pending', :notes, NOW(), NOW())
            """),
            {"admin_id": current_user.id, "items": items_json, "notes": payload.notes},
        )
        db.commit()
        reorder_id = int(result.lastrowid or 0)
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"DB 오류: {exc}") from exc

    row = db.execute(
        text("SELECT * FROM reorder_history WHERE id = :id"),
        {"id": reorder_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=500, detail="발주 생성 실패")

    return _row_to_response(dict(row), _get_admin_name(db, current_user.id))


@router.get("", response_model=List[ReorderResponse])
async def list_reorders(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="관리자만 접근 가능합니다.")

    _ensure_reorder_table(db)

    rows = db.execute(
        text("SELECT * FROM reorder_history ORDER BY created_at DESC")
    ).mappings().all()

    return [_row_to_response(dict(row), _get_admin_name(db, int(row["admin_id"]))) for row in rows]


@router.patch("/{reorder_id}/status", response_model=ReorderResponse)
async def update_reorder_status(
    reorder_id: int,
    payload: ReorderStatusUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="관리자만 접근 가능합니다.")

    new_status = payload.status.strip().lower()
    if new_status not in STATUS_TRANSITIONS:
        raise HTTPException(status_code=422, detail="유효하지 않은 상태입니다.")

    row = db.execute(
        text("SELECT * FROM reorder_history WHERE id = :id"),
        {"id": reorder_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="발주를 찾을 수 없습니다.")

    current_status = str(row["status"])
    if new_status not in STATUS_TRANSITIONS.get(current_status, []):
        raise HTTPException(
            status_code=422,
            detail=f"'{STATUS_LABELS.get(current_status)}'에서 '{STATUS_LABELS.get(new_status)}'으로 변경할 수 없습니다.",
        )

    try:
        db.execute(
            text("UPDATE reorder_history SET status = :status, updated_at = NOW() WHERE id = :id"),
            {"status": new_status, "id": reorder_id},
        )

        # 입고 확인 시 재고 자동 증가 (product_name 앞 숫자로 item_no 매칭)
        if new_status == "received":
            items = dict(row).get("items") or []
            if isinstance(items, str):
                items = json.loads(items)
            for item in items:
                product_name = item.get("product_name", "")
                quantity = int(item.get("quantity", 0))
                if product_name and quantity > 0:
                    # "10093_농심매운새우깡90G" → "10093"
                    extracted_item_no = product_name.split("_")[0].strip()
                    db.execute(
                        text("""
                            UPDATE products
                            SET stock = COALESCE(stock, 0) + :qty,
                                updated_at = NOW()
                            WHERE item_no = :item_no
                        """),
                        {"qty": quantity, "item_no": extracted_item_no},
                    )

        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"DB 오류: {exc}") from exc

    updated_row = db.execute(
        text("SELECT * FROM reorder_history WHERE id = :id"),
        {"id": reorder_id},
    ).mappings().first()
    return _row_to_response(dict(updated_row), _get_admin_name(db, int(row["admin_id"])))


@router.delete("/{reorder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_reorder(
    reorder_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="관리자만 접근 가능합니다.")

    row = db.execute(
        text("SELECT status FROM reorder_history WHERE id = :id"),
        {"id": reorder_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="발주를 찾을 수 없습니다.")

    if str(row["status"]) not in ("pending", "cancelled"):
        raise HTTPException(status_code=422, detail="대기 중이거나 취소된 발주만 삭제할 수 있습니다.")

    try:
        db.execute(
            text("DELETE FROM reorder_history WHERE id = :id"),
            {"id": reorder_id},
        )
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"DB 오류: {exc}") from exc