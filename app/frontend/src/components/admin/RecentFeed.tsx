import type { PurchaseResponse } from "../../api/purchases";

interface RecentFeedProps {
  items: PurchaseResponse[];
}

function stripItemNo(name: string) {
  const m = name.match(/^\d+_(.+)$/);
  return m ? m[1] : name;
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}시간 전`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}일 전`;
}

export default function RecentFeed({ items }: RecentFeedProps) {
  return (
    <div className="bg-white border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-3.5">
        <div>
          <div className="text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
            <span>🧾</span>최근 구매
          </div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            실시간으로 업데이트됩니다
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-50 text-green-700 text-[11px] font-bold">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          LIVE
        </span>
      </div>

      {!items || items.length === 0 ? (
        <div className="h-32 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
          최근 구매 내역이 없습니다.
        </div>
      ) : (
        <div className="flex flex-col gap-2 max-h-[520px] overflow-y-auto pr-1.5">
          {items.map((p) => {
            const userInitial = (p.username || "U").slice(0, 1);
            return (
              <div
                key={p.id}
                className="p-3 border border-slate-100 rounded-xl hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-start gap-2.5 mb-2">
                  <div className="w-8 h-8 rounded-full bg-orange-50 text-orange-500 flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {userInitial}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-[var(--color-text)]">
                      {p.username}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {relTime(p.timestamp)} · #{p.id}
                    </div>
                  </div>
                  <div className="text-sm font-bold text-[var(--color-primary)]">
                    ₩{(p.total_amount ?? 0).toLocaleString("ko-KR")}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {p.items.slice(0, 4).map((it, i) => (
                    <span
                      key={i}
                      className="px-1.5 py-0.5 bg-orange-50 text-orange-700 rounded text-[11px] font-medium"
                    >
                      {stripItemNo(it.name)} × {it.count}
                    </span>
                  ))}
                  {p.items.length > 4 && (
                    <span className="px-1.5 py-0.5 text-[var(--color-text-muted)] text-[11px]">
                      +{p.items.length - 4}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
