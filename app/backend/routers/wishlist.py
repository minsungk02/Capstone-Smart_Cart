from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import List
from pydantic import BaseModel
from backend.database import get_db
from backend.routers.auth import get_current_user
from backend.models import Wishlist, User

router = APIRouter(tags=["wishlist"])

class WishlistCreate(BaseModel):
    item_no: str
    product_name: str

@router.get("/wishlist")
async def get_wishlist(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    wishlist_items = db.query(Wishlist).filter(Wishlist.user_id == current_user.id).all()
    
    results = []
    for item in wishlist_items:
        price_row = db.execute(
            text("""
                SELECT p.price 
                FROM product_prices p
                JOIN products pr ON p.product_id = pr.id
                WHERE pr.item_no = :item_no
                ORDER BY p.checked_at DESC LIMIT 1
            """),
            {"item_no": item.item_no}
        ).mappings().first()
        
        results.append({
            "id": item.id,
            "item_no": item.item_no,
            "product_name": item.product_name,
            "price": price_row["price"] if price_row else None,
            "created_at": item.created_at.isoformat()
        })
    return results

@router.post("/wishlist")
async def add_to_wishlist(payload: WishlistCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    exists = db.query(Wishlist).filter(
        Wishlist.user_id == current_user.id,
        Wishlist.item_no == payload.item_no
    ).first()
    
    if exists:
        return {"status": "already_exists"}
        
    new_item = Wishlist(
        user_id=current_user.id,
        item_no=payload.item_no,
        product_name=payload.product_name
    )
    db.add(new_item)
    db.commit()
    return {"status": "added"}

@router.delete("/wishlist/{wishlist_id}")
async def remove_from_wishlist(wishlist_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(Wishlist).filter(Wishlist.id == wishlist_id, Wishlist.user_id == current_user.id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    
    db.delete(item)
    db.commit()
    return {"status": "deleted"}