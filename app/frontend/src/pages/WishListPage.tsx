import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import { getWishlist, removeFromWishlist } from "../api/wishlist";
// TS 에러 방지를 위한 type-only import
import type { WishlistItem } from "../api/wishlist"; 

export default function WishListPage() {
  const { token } = useAuthStore();
  const queryClient = useQueryClient();

  // 1. 찜 목록 데이터 조회
  const { data: wishlist = [], isLoading } = useQuery({
    queryKey: ["wishlist", token],
    queryFn: () => getWishlist(token!),
    enabled: !!token,
  });

  // 2. 삭제 기능
  const deleteMutation = useMutation({
    mutationFn: (id: number) => removeFromWishlist(token!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    },
    onError: () => alert("삭제 중 오류가 발생했습니다."),
  });

  // 3. 총 결제 금액 계산[cite: 1]
  const totalAmount = useMemo(() => {
    return wishlist.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  }, [wishlist]);

  return (
    <div className="p-8 md:p-12 max-w-5xl mx-auto bg-[#f8fafc] min-h-full font-sans">
      {/* 타이틀 영역[cite: 1] */}
      <div className="flex justify-between items-center mb-8 px-2">
        <div className="flex items-center gap-3">
          <span className="text-2xl">❤️</span>
          <h1 className="text-2xl font-bold text-[#1e293b]">찜한 상품 목록</h1>
        </div>
        <span className="text-gray-400 font-medium text-lg">총 {wishlist.length}개</span>
      </div>

      {/* 상품 리스트 박스[cite: 1] */}
      <div className="bg-white rounded-[2.5rem] border border-gray-200 shadow-sm overflow-hidden mb-12">
        {isLoading ? (
          <div className="p-20 text-center text-orange-500 font-bold animate-pulse">정보를 불러오는 중...</div>
        ) : wishlist.length === 0 ? (
          <div className="p-20 text-center text-gray-400 font-medium">찜한 상품이 없습니다.</div>
        ) : (
          wishlist.map((item: WishlistItem, idx) => (
            <div 
              key={item.id} 
              className={`flex items-center p-7 ${
                idx !== wishlist.length - 1 ? 'border-b border-gray-50' : ''
              }`}
            >
              {/* 상품 아이콘[cite: 1] */}
              <div className="w-16 h-16 bg-[#fff7ed] rounded-2xl flex items-center justify-center mr-6 shrink-0">
                <span className="text-2xl">📦</span>
              </div>

              {/* 상품 정보[cite: 1] */}
              <div className="flex-1">
                <h3 className="text-xl font-bold text-[#1e293b]">{item.product_name}</h3>
                <p className="text-sm text-gray-400 font-medium">상품번호: {item.item_no}</p>
              </div>

              {/* 개별 가격 표시: 요청하신 대로 '1,755원' 형식으로 통일[cite: 1] */}
              <div className="flex items-center gap-10">
                <span className="text-xl font-bold text-[#1e293b]">
                  {(Number(item.price) || 0).toLocaleString()}원
                </span>
                <button 
                  onClick={() => { if(confirm("삭제하시겠습니까?")) deleteMutation.mutate(item.id); }}
                  className="text-[#f87171] font-bold text-base hover:underline transition-all"
                >
                  삭제
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 우측 하단 전체 금액[cite: 1] */}
      <div className="flex justify-end pr-6">
        <div className="text-right">
          <h2 className="text-2xl font-bold text-[#1e293b] tracking-tight">
            전체 금액 : {totalAmount.toLocaleString()}원
          </h2>
        </div>
      </div>
    </div>
  );
}