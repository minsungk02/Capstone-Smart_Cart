import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import {
  getDashboardStats,
  getDiscountCategories,
  getDiscountProducts,
  getPopularProducts,
} from "../api/purchases";
import { addToWishlist } from "../api/wishlist";
import type { Product } from "../api/products";

const PERIOD_OPTIONS = [7, 30, 90] as const;
type PeriodDays = (typeof PERIOD_OPTIONS)[number];

const formatAmount = (value: number) => `₩${(value ?? 0).toLocaleString("ko-KR")}`;
const formatDiscountAmount = (value: number) => `₩${Math.max(0, value ?? 0).toLocaleString("ko-KR")}`;

function formatDiscountRate(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${safe.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
}

function formatCompactAmount(value: number): string {
  if (value <= 0) return "0";
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}억`;
  if (value >= 10000) return `${Math.round(value / 10000)}만`;
  return `${Math.round(value / 1000)}천`;
}

function formatDateLabel(date: string): string {
  return new Date(date).toLocaleDateString("ko-KR", {
    month: "numeric",
    day: "numeric",
  });
}

function buildOrderTicks(maxValue: number): number[] {
  const ratios = [1, 0.75, 0.5, 0.25, 0];
  const raw = ratios.map((ratio) => Math.round(maxValue * ratio));
  const unique = Array.from(new Set(raw));
  if (!unique.includes(0)) unique.push(0);
  return unique;
}

export default function HomePage() {
  const { isAdmin, token } = useAuthStore();
  const queryClient = useQueryClient();
  const isAdminUser = isAdmin();
  const [periodDays, setPeriodDays] = useState<PeriodDays>(7);
  const [failedPopularImages, setFailedPopularImages] = useState<Record<string, true>>({});
  const [selectedDiscountCategory, setSelectedDiscountCategory] = useState("");
  const [failedDiscountImages, setFailedDiscountImages] = useState<Record<string, true>>({});

  const wishlistMutation = useMutation({
    mutationFn: ({ itemNo, name }: { itemNo: string; name: string }) =>
      addToWishlist(token!, itemNo, name),
    onSuccess: (data) => {
      if (data.status === "already_exists") {
        alert("이미 찜목록에 등록된 상품입니다.");
      } else {
        alert("찜 목록에 추가되었습니다!");
        queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      }
    },
    onError: () => {
      alert("찜하기에 실패했습니다.");
    }
  });

  const { data: stats, isLoading } = useQuery({
    queryKey: ["dashboard", "stats", periodDays, token],
    queryFn: () => getDashboardStats(token!, periodDays),
    enabled: isAdminUser && !!token,
  });

  const { data: userPopularProducts = [] } = useQuery({
    queryKey: ["popular-products", "user-popup", token],
    queryFn: () => getPopularProducts(token!, 5),
    enabled: !isAdminUser && !!token,
  });

  const { data: discountCategories = [], isLoading: isDiscountCategoriesLoading } = useQuery({
    queryKey: ["discount-categories", "user-home", token],
    queryFn: () => getDiscountCategories(token!),
    enabled: !isAdminUser && !!token,
  });

  const { data: discountProducts = [], isLoading: isDiscountProductsLoading } = useQuery({
    queryKey: ["discount-products", "user-home", token, selectedDiscountCategory],
    queryFn: () => getDiscountProducts(token!, selectedDiscountCategory, 5),
    enabled: !isAdminUser && !!token && selectedDiscountCategory.length > 0,
  });

  useEffect(() => {
    setFailedPopularImages({});
  }, [userPopularProducts]);

  useEffect(() => {
    if (discountCategories.length === 0) {
      if (selectedDiscountCategory !== "") {
        setSelectedDiscountCategory("");
      }
      return;
    }
    if (!discountCategories.includes(selectedDiscountCategory)) {
      setSelectedDiscountCategory(discountCategories[0]);
    }
  }, [discountCategories, selectedDiscountCategory]);

  useEffect(() => {
    setFailedDiscountImages({});
  }, [selectedDiscountCategory, discountProducts]);

  if (isAdminUser) {
    const dailyStats = stats?.daily_stats ?? [];
    const maxOrderCount = Math.max(1, ...dailyStats.map((row) => row.purchase_count));
    const maxPopularCount = Math.max(1, ...(stats?.popular_products ?? []).map((p) => p.total_count));
    const orderTicks = buildOrderTicks(maxOrderCount);
    const chartMinWidth = Math.max(560, dailyStats.length * 42);
    const revenueBadgeStride = dailyStats.length <= 10 ? 1 : dailyStats.length <= 30 ? 3 : 7;
    const labelStride = dailyStats.length <= 14 ? 1 : dailyStats.length <= 40 ? 4 : 8;

    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-[var(--color-text)] mb-1">관리자 대시보드</h1>
            <p className="text-sm md:text-base text-[var(--color-text-secondary)]">매출/주문 추이와 고객 구매 패턴을 한눈에 확인하세요</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/products" className="inline-flex items-center rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-muted)]">상품 관리</Link>
            <Link to="/admin/purchases" className="inline-flex items-center rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-muted)]">구매 내역</Link>
          </div>
        </div>
        {isLoading ? (
          <div className="text-center py-12"><p className="text-[var(--color-text-secondary)]">로딩 중...</p></div>
        ) : stats ? (
          <>
            <div className="relative bg-white rounded-2xl p-5 md:p-6 border border-[var(--color-border)] shadow-sm">
              <div className="relative z-10 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                <div>
                  <h2 className="text-xl md:text-2xl font-bold text-[var(--color-text)]">최근 {periodDays}일 매출/주문 추이</h2>
                  <p className="text-sm text-[var(--color-text-secondary)] mt-1">좌측 축: 주문건수, 원형 뱃지: 일매출</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-xl border border-orange-200 bg-orange-50/70 p-1">
                    {PERIOD_OPTIONS.map((daysOption) => (
                      <button key={daysOption} type="button" onClick={() => setPeriodDays(daysOption)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${periodDays === daysOption ? "bg-orange-500 text-white shadow-sm" : "text-orange-700 hover:bg-orange-100"}`}>{daysOption}일</button>
                    ))}
                  </div>
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-orange-50 text-orange-700 text-xs font-semibold">
                    <span>오늘 매출</span>
                    <span>{formatAmount(stats.today_revenue)}</span>
                  </div>
                </div>
              </div>
              {dailyStats.length > 0 ? (
                <div className="mt-6 overflow-x-auto pb-2">
                  <div style={{ minWidth: `${chartMinWidth}px` }}>
                    <div className="flex items-stretch gap-2">
                      <div className="w-10 shrink-0 h-72 relative">
                        {orderTicks.map((tick, idx) => (
                          <div key={idx} className="absolute right-0 -translate-y-1/2 text-[11px] text-orange-700 font-semibold" style={{ top: `${(idx / (orderTicks.length - 1 || 1)) * 100}%` }}>{tick}</div>
                        ))}
                      </div>
                      <div className="flex-1 relative h-72">
                        {orderTicks.map((_, idx) => (
                          <div key={idx} className="absolute left-0 right-0 border-t border-orange-100" style={{ top: `${(idx / (orderTicks.length - 1 || 1)) * 100}%` }} />
                        ))}
                        <div className="absolute inset-0 grid gap-2" style={{ gridTemplateColumns: `repeat(${dailyStats.length}, minmax(0, 1fr))` }}>
                          {dailyStats.map((point, idx) => {
                            const baseHeight = point.purchase_count > 0 ? 10 + Math.round((point.purchase_count / maxOrderCount) * 78) : 5;
                            const showRevenueBadge = idx % revenueBadgeStride === 0 || idx === dailyStats.length - 1;
                            return (
                              <div key={point.date} className="relative flex items-end justify-center">
                                <div className="w-full max-w-[24px] rounded-t-md bg-gradient-to-t from-orange-500 via-orange-400 to-amber-300" style={{ height: `${baseHeight}%` }} />
                                {showRevenueBadge && (
                                  <div className="absolute left-1/2 -translate-x-1/2 h-7 px-2 rounded-full border border-orange-300 bg-white text-orange-700 text-[10px] font-semibold flex items-center justify-center shadow-sm whitespace-nowrap" style={{ bottom: `calc(${baseHeight}% + 6px)` }}>{formatCompactAmount(point.revenue)}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-6 h-64 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">데이터가 없습니다.</div>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <div className="bg-white rounded-2xl p-5 border border-[var(--color-border)] shadow-sm">
                <p className="text-sm text-[var(--color-text-secondary)]">총 매출</p>
                <p className="mt-2 text-2xl font-bold">{formatAmount(stats.total_revenue)}</p>
              </div>
              <div className="bg-white rounded-2xl p-5 border border-[var(--color-border)] shadow-sm">
                <p className="text-sm text-[var(--color-text-secondary)]">평균 객단가</p>
                <p className="mt-2 text-2xl font-bold">{formatAmount(stats.average_order_value)}</p>
              </div>
              <div className="bg-white rounded-2xl p-5 border border-[var(--color-border)] shadow-sm">
                <p className="text-sm text-[var(--color-text-secondary)]">총 주문수</p>
                <p className="mt-2 text-2xl font-bold">{stats.total_purchases}건</p>
              </div>
              <div className="bg-white rounded-2xl p-5 border border-[var(--color-border)] shadow-sm">
                <p className="text-sm text-[var(--color-text-secondary)]">오늘 주문수</p>
                <p className="mt-2 text-2xl font-bold">{stats.today_purchases}건</p>
              </div>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-6xl mx-auto space-y-4 md:space-y-6 lg:space-y-8">
      <div className="bg-white rounded-2xl p-6 border border-[var(--color-border)] shadow-sm">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-2xl font-bold text-[var(--color-text)] mb-1">실시간 베스트</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">지금 가장 많이 담긴 인기 상품 TOP 5</p>
          </div>
          <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-orange-50 text-orange-700 text-xs font-semibold">LIVE TOP5</span>
        </div>
        {userPopularProducts.length > 0 ? (
          <>
            <div className="flex gap-1.5 sm:gap-2.5 overflow-x-auto pb-1 snap-x snap-mandatory">
              {userPopularProducts.map((product, index) => {
                const hasPicture = Boolean(product.picture) && !failedPopularImages[product.name];
                const currentItemNo = (product as any).item_no || product.name; 

                return (
                  <div key={product.name} className="relative min-w-[100px] sm:min-w-[126px] max-w-[147px] shrink-0 snap-start rounded-xl border border-[var(--color-border)] bg-white p-2.5 sm:p-3.5">
                    <button onClick={() => wishlistMutation.mutate({ itemNo: currentItemNo, name: product.name })} className="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center bg-white/90 hover:bg-white rounded-full shadow-sm border border-gray-100 transition-transform active:scale-90">
                      <span className="text-xs">❤️</span>
                    </button>
                    <div className="flex items-center justify-between mb-2">
                      <span className="inline-flex w-6 h-6 items-center justify-center rounded-full bg-orange-100 text-orange-700 text-[11px] font-bold">{index + 1}</span>
                      <span className="text-xs font-semibold text-[var(--color-primary)]">{product.total_count}개</span>
                    </div>
                    {hasPicture ? (
                      <img src={product.picture || ""} alt={product.name} className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl object-contain bg-white p-1 mb-2.5 border border-[var(--color-border)]" onError={() => setFailedPopularImages((prev) => ({ ...prev, [product.name]: true }))} />
                    ) : (
                      <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl bg-[var(--color-primary-light)] text-[var(--color-primary)] flex items-center justify-center text-base font-bold mb-2.5">{(product.name || "?").slice(0, 1)}</div>
                    )}
                    <p className="text-[13px] sm:text-sm leading-tight font-semibold text-[var(--color-text)] break-words line-clamp-2 min-h-[2.2rem]">{product.name}</p>
                  </div>
                );
              })}
            </div>
            
            <div className="flex justify-end mt-4">
              <Link 
                to="/all-products" 
                className="text-sm font-bold text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] transition-colors px-2 py-1 flex items-center gap-1"
              >
                전체 상품 더보기 <span className="text-lg">›</span>
              </Link>
            </div>
          </>
        ) : (
          <div className="h-24 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">데이터가 없습니다.</div>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl p-8 border border-[var(--color-border)] shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-14 h-14 rounded-2xl bg-[var(--color-primary-light)] flex items-center justify-center flex-shrink-0">
              <img src="/jangbogo.svg" alt="장보GO" className="w-10 h-10 rounded-xl object-cover" />
            </div>
            <div className="flex-1">
              <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">장보GO</h3>
              <p className="text-sm text-[var(--color-text-secondary)]">카메라에 상품을 보여주면 자동으로 장바구니에 담깁니다.</p>
            </div>
          </div>
          <Link to="/checkout" className="block w-full py-3 px-6 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium rounded-xl text-center">장보GO 시작</Link>
        </div>
        <div className="bg-white rounded-2xl p-8 border border-[var(--color-border)] shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-14 h-14 rounded-2xl bg-[var(--color-secondary-light)] flex items-center justify-center flex-shrink-0">
              <span className="text-3xl">📋</span>
            </div>
            <div className="flex-1">
              <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">영수증 확인</h3>
              <p className="text-sm text-[var(--color-text-secondary)]">체크아웃한 상품 목록을 확인하고 수정할 수 있습니다.</p>
            </div>
          </div>
          <Link to="/validate" className="block w-full py-3 px-6 bg-white hover:bg-gray-50 text-[var(--color-text)] font-medium rounded-xl text-center border border-[var(--color-border)]">영수증 확인</Link>
        </div>
      </div>
    </div>
  );
}