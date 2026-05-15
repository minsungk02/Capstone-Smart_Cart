import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import {
  getDashboardStats,
  getDiscountCategories,
  getDiscountProducts,
} from "../api/purchases";
import KpiCards from "../components/admin/KpiCards";
import PeriodFilter from "../components/admin/PeriodFilter";
import TrendChart from "../components/admin/TrendChart";
import type { TrendMetric } from "../components/admin/TrendChart";
import PopularProductsCard from "../components/admin/PopularProductsCard";
import DiscountPanel from "../components/admin/DiscountPanel";
import CategoryDonut from "../components/admin/CategoryDonut";
import RecentFeed from "../components/admin/RecentFeed";

type PeriodDays = 7 | 14 | 30;

export default function AdminDashboardPage() {
  const { token } = useAuthStore();
  const [periodDays, setPeriodDays] = useState<PeriodDays>(7);
  const [metric, setMetric] = useState<TrendMetric>("revenue");
  const [discountCategory, setDiscountCategory] = useState("");

  const { data: stats, isLoading } = useQuery({
    queryKey: ["dashboard", "stats", periodDays, token],
    queryFn: () => getDashboardStats(token!, periodDays),
    enabled: !!token,
  });

  const { data: discountCategories = [] } = useQuery({
    queryKey: ["discount-categories", "admin-dashboard", token],
    queryFn: () => getDiscountCategories(token!),
    enabled: !!token,
  });

  const activeDiscountCategory = discountCategories.includes(discountCategory)
    ? discountCategory
    : discountCategories[0] ?? "";

  const { data: discountProducts = [], isLoading: isDiscountLoading } = useQuery({
    queryKey: ["discount-products", "admin-dashboard", token, activeDiscountCategory],
    queryFn: () => getDiscountProducts(token!, activeDiscountCategory, 5),
    enabled: !!token && activeDiscountCategory.length > 0,
  });

  const periodLabel = `최근 ${periodDays}일`;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-tight text-[var(--color-text)] flex items-center gap-2">
            <span>📊</span>관리자 대시보드
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {periodLabel} 기준 · 매출/주문 추이와 고객 구매 패턴을 한눈에 확인하세요
          </p>
        </div>
        <PeriodFilter
          value={periodDays}
          onChange={(v) => setPeriodDays(v as PeriodDays)}
        />
      </div>

      {isLoading ? (
        <div className="bg-white border border-[var(--color-border)] rounded-2xl p-12 text-center shadow-sm">
          <p className="text-sm text-[var(--color-text-secondary)]">로딩 중...</p>
        </div>
      ) : stats ? (
        <>
          <KpiCards stats={stats} periodLabel={periodLabel} />

          <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-5">
            <TrendChart
              data={stats.daily_stats}
              metric={metric}
              onMetricChange={setMetric}
            />
            <PopularProductsCard items={stats.popular_products} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <DiscountPanel
              categories={discountCategories}
              selectedCategory={activeDiscountCategory}
              onCategoryChange={setDiscountCategory}
              items={discountProducts}
              isLoading={isDiscountLoading}
            />
            <CategoryDonut purchases={stats.recent_purchases} />
          </div>

          <RecentFeed items={stats.recent_purchases} />
        </>
      ) : (
        <div className="bg-white border border-dashed border-[var(--color-border)] rounded-2xl p-12 text-center">
          <p className="text-sm text-[var(--color-text-secondary)]">
            대시보드 데이터를 불러오지 못했습니다.
          </p>
        </div>
      )}
    </div>
  );
}
