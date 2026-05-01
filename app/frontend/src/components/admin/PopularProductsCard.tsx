import type { PopularProduct } from "../../api/purchases";

interface PopularProductsCardProps {
  items: PopularProduct[];
}

const MEDAL_BG = ["bg-amber-100", "bg-slate-200", "bg-orange-200", "bg-slate-100", "bg-slate-100"];
const MEDAL_FG = ["text-amber-700", "text-slate-600", "text-orange-700", "text-slate-500", "text-slate-500"];

function stripItemNo(name: string) {
  const m = name.match(/^\d+_(.+)$/);
  return m ? m[1] : name;
}

export default function PopularProductsCard({ items }: PopularProductsCardProps) {
  if (!items || items.length === 0) {
    return (
      <div className="bg-white border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
        <div className="text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
          <span>🏆</span>인기 상품 TOP 5
        </div>
        <div className="mt-4 h-32 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
          아직 판매 데이터가 없습니다.
        </div>
      </div>
    );
  }

  const max = Math.max(...items.map((i) => i.total_count), 1);

  return (
    <div className="bg-white border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-3.5">
        <div>
          <div className="text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
            <span>🏆</span>인기 상품 TOP 5
          </div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            누적 판매 수량 기준
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2.5">
        {items.map((p, idx) => {
          const pct = (p.total_count / max) * 100;
          const cleanName = stripItemNo(p.name);
          return (
            <div key={p.name} className="flex items-center gap-3">
              <span
                className={`w-6 h-6 inline-flex items-center justify-center rounded-full text-xs font-bold flex-shrink-0 ${MEDAL_BG[idx]} ${MEDAL_FG[idx]}`}
              >
                {idx + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-[13px] font-semibold text-[var(--color-text)] truncate">
                    {cleanName}
                  </span>
                  <span className="text-xs font-bold text-[var(--color-primary)] flex-shrink-0 ml-2.5">
                    {p.total_count.toLocaleString("ko-KR")}개
                  </span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-400 transition-[width] duration-[400ms] ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
