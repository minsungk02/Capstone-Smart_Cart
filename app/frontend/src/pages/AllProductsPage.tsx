import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useInView } from "react-intersection-observer"; 
import { useAuthStore } from "../stores/authStore";
import { listProducts } from "../api/products";
import { addToWishlist } from "../api/wishlist";

export default function AllProductsPage() {
  const navigate = useNavigate();
  const { token } = useAuthStore();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const { ref, inView } = useInView();

  const PAGE_SIZE = 24;

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError
  } = useInfiniteQuery({
    queryKey: ["all-products-infinite", token],
    queryFn: ({ pageParam = 0 }) => listProducts(token!, { skip: pageParam as number, limit: PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const currentLoaded = allPages.length * PAGE_SIZE;
      return lastPage.has_more ? currentLoaded : undefined;
    },
    enabled: !!token,
  });

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const allProducts = useMemo(() => 
    data?.pages.flatMap((page) => page.products) || [], 
  [data]);

  const filteredProducts = useMemo(() => {
    return allProducts.filter(product => 
      product.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [allProducts, searchQuery]);

  const wishlistMutation = useMutation({
    mutationFn: ({ itemNo, name }: { itemNo: string; name: string }) =>
      addToWishlist(token!, itemNo, name),
    onSuccess: (res) => {
      alert(res.status === "already_exists" ? "이미 찜목록에 등록된 상품입니다." : "찜 목록에 추가되었습니다!");
      queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    },
    onError: () => alert("찜하기 처리에 실패했습니다.")
  });

  return (
    <div className="flex flex-col min-h-full bg-[var(--color-bg)]">
      {/* 상단 고정 헤더 영역 */}
      <div className="sticky top-0 z-30 bg-[var(--color-bg)] border-b border-[var(--color-border)] shadow-sm">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-2 hover:bg-white rounded-full border border-transparent hover:border-gray-200 transition-all">
              <span className="text-2xl">←</span>
            </button>
            <div>
              <h1 className="text-2xl font-bold text-[var(--color-text)]">전체 상품 보기</h1>
              <p className="text-xs text-[var(--color-text-secondary)]">총 {data?.pages[0]?.total_count || 0}개의 상품</p>
            </div>
          </div>

          <div className="relative w-full md:w-96">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            <input
              type="text"
              placeholder="상품명을 입력하세요"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-11 pr-4 py-3 rounded-2xl border border-[var(--color-border)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 shadow-sm transition-all"
            />
          </div>
        </div>
      </div>

      {/* 리스트 렌더링 영역 */}
      <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
        {isLoading ? (
          <div className="flex justify-center py-32">
            <div className="w-10 h-10 border-4 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : isError ? (
          <div className="py-32 text-center text-red-500 font-bold">오류가 발생했습니다.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-5">
            {filteredProducts.map((product, idx) => (
              <div key={`${product.item_no}-${idx}`} className="group relative bg-white rounded-2xl border border-[var(--color-border)] p-4 shadow-sm hover:shadow-md transition-all">
                <button 
                  onClick={() => wishlistMutation.mutate({ itemNo: product.item_no, name: product.name })}
                  className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center bg-white/90 rounded-full shadow-sm border border-gray-100 hover:scale-110 active:scale-95 transition-all"
                >
                  <span className="text-xs">❤️</span>
                </button>

                <div className="aspect-square bg-gray-50 rounded-xl mb-3 flex items-center justify-center overflow-hidden">
                  {product.picture ? (
                    <img src={product.picture} alt={product.name} className="w-full h-full object-contain p-2 group-hover:scale-105 transition-transform duration-500" loading="lazy" />
                  ) : (
                    <span className="text-3xl font-black text-gray-200">{product.name.slice(0, 1)}</span>
                  )}
                </div>
                <p className="text-sm font-bold text-[var(--color-text)] line-clamp-2 min-h-[2.5rem] leading-snug">{product.name}</p>
                
                {/* 가격 우측 정렬 적용: justify-end 클래스 사용 */}
                <div className="flex items-center justify-end mt-2">
                  <span className="text-sm text-orange-600 font-bold">
                    {product.price ? `${Number(product.price).toLocaleString()}원` : "가격 미정"}
                  </span>
                </div>
              </div>
            ))}

            {/* 무한 스크롤 센서 */}
            <div ref={ref} className="col-span-full h-20 flex items-center justify-center">
              {isFetchingNextPage ? (
                <div className="w-6 h-6 border-2 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
              ) : !hasNextPage && allProducts.length > 0 ? (
                <p className="text-sm text-gray-400 italic">모든 상품을 불러왔습니다.</p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}