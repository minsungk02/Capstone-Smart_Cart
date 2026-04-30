from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, Integer, JSON, String, Text, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from backend.database import Base


class User(Base):
    """인증을 위한 사용자 모델"""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    name = Column(String(100))
    role = Column(String(20), default="user", nullable=False)  # 'user' 또는 'admin'
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    # 관계 설정
    purchase_history = relationship("PurchaseHistory", back_populates="user")
    wishlists = relationship("Wishlist", back_populates="user")

    def __repr__(self):
        return f"<User(id={self.id}, username={self.username}, role={self.role})>"


class PurchaseHistory(Base):
    """구매 내역 모델"""

    __tablename__ = "purchase_history"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    items = Column(JSON, nullable=False)  # [{"name": "상품명", "count": 2, "price": 3000}, ...]
    total_amount = Column(Integer, nullable=False)  # 총 결제 금액
    timestamp = Column(DateTime, default=datetime.utcnow)
    notes = Column(Text)  # 선택적 메모

    # 관계 설정
    user = relationship("User", back_populates="purchase_history")

    def __repr__(self):
        return f"<PurchaseHistory(id={self.id}, user_id={self.user_id}, total={self.total_amount})>"


class Wishlist(Base):
    """찜목록 모델"""

    __tablename__ = "wishlists"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    item_no = Column(String(50), nullable=False) # 상품 고유 번호
    product_name = Column(String(100))
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint('user_id', 'item_no', name='_user_item_uc'),
    )

    # 관계 설정
    user = relationship("User", back_populates="wishlists")

    def __repr__(self):
        return f"<Wishlist(id={self.id}, user_id={self.user_id}, item_no={self.item_no})>"