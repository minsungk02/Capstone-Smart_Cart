import type { DiscountProduct } from "../../api/purchases";

interface DiscountPanelProps {
  categories: string[];
  selectedCategory: string;
  onCategoryChange: (c: string) => void;
  items: DiscountProduct[];
  isLoading?: boolean;
}

const MEDAL_BG = ["bg-red-100", "bg-orange-200", "bg-amber-100", "bg-slate-100", "bg-slate-100"];
const MEDAL_FG = ["text-red-700", "text-orange-700", "text-amber-700", "text-slate-500", "text-slate-500"];

function formatRate(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${safe.toFixed(1)}%`;
}

export default function DiscountPanel({
  categories,
  selectedCategory,
  onCategoryChange,
  items,
  isLoading,
}: DiscountPanelProps) {
  return (
    <div className="bg-white border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-3.5">
        <div>
          <div className="text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
            <span>🏷️</span>카테고리별 할인 상품 TOP 5
          </div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            선택한 카테고리에서 할인율이 높은 상품
          </div>
        </div>
        {selectedCategory && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-red-50 text-red-700 text-xs font-bold whitespace-nowrap">
            {selectedCategory}
          </span>
        )}
      </div>

      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3.5">
          {categories.map((c) => {
            const on = selectedCategory === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => onCategoryChange(c)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  on
                    ? "bg-orange-50 border-orange-300 text-orange-700"
                    : "bg-white border-[var(--color-border)] text-slate-600 hover:bg-gray-50"
                }`}
              >
                {c}
              </button>
            );
          })}
        </div>
      )}

      {isLoading ? (
        <div className="h-28 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
          할인 상품 로딩 중...
        </div>
      ) : items.length === 0 ? (
        <div className="h-28 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
          {selectedCategory ? `${selectedCategory} 카테고리의 할인 상품이 없습니다.` : "표시할 카테고리가 없습니다."}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((d, idx) => (
            <div
              key={`${d.item_no}-${idx}`}
              className="flex items-center gap-3 px-3 py-2.5 border border-slate-100 rounded-xl"
            >
              <span
                className={`w-6 h-6 inline-flex items-center justify-center rounded-full text-[11px] font-bold flex-shrink-0 ${MEDAL_BG[idx]} ${MEDAL_FG[idx]}`}
              >
                {idx + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-[var(--color-text)] truncate">
                  {d.product_name}
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  상품코드: {d.item_no}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-extrabold text-red-700">
                  {formatRate(d.discount_rate ?? 0)}
                </div>
                <div className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                  ₩{Math.max(0, d.discount_amount ?? 0).toLocaleString("ko-KR")}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
