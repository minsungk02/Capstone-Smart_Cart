import type { DashboardStats } from "../../api/purchases";

interface KpiCardsProps {
  stats: DashboardStats;
  periodLabel: string;
}

type Tone = "orange" | "blue" | "green" | "purple";

const toneClasses: Record<Tone, { bg: string; fg: string }> = {
  orange: { bg: "bg-orange-50", fg: "text-orange-500" },
  blue: { bg: "bg-blue-100", fg: "text-blue-600" },
  green: { bg: "bg-green-100", fg: "text-green-600" },
  purple: { bg: "bg-violet-100", fg: "text-violet-600" },
};

export default function KpiCards({ stats, periodLabel }: KpiCardsProps) {
  const krw = (v: number) => `₩${(v ?? 0).toLocaleString("ko-KR")}`;

  const cards: Array<{
    key: string;
    label: string;
    value: string;
    delta: string;
    deltaLabel: string;
    tone: Tone;
    icon: React.ReactNode;
  }> = [
    {
      key: "revenue",
      label: "총 매출",
      value: krw(stats.total_revenue),
      delta: `+ ${krw(stats.today_revenue)}`,
      deltaLabel: "오늘",
      tone: "orange",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v18" /><path d="M17 6H9a3 3 0 0 0 0 6h6a3 3 0 0 1 0 6H7" />
        </svg>
      ),
    },
    {
      key: "orders",
      label: "총 구매 건수",
      value: `${stats.total_purchases.toLocaleString("ko-KR")}건`,
      delta: `+${stats.today_purchases.toLocaleString("ko-KR")}건`,
      deltaLabel: "오늘",
      tone: "blue",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" />
        </svg>
      ),
    },
    {
      key: "aov",
      label: "평균 객단가",
      value: krw(Math.round(stats.average_order_value)),
      delta: `${periodLabel} 기준`,
      deltaLabel: "",
      tone: "green",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" />
        </svg>
      ),
    },
    {
      key: "customers",
      label: "고객 수",
      value: `${stats.total_customers.toLocaleString("ko-KR")}명`,
      delta: "활성 사용자",
      deltaLabel: "",
      tone: "purple",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {cards.map((c) => {
        const t = toneClasses[c.tone];
        return (
          <div
            key={c.key}
            className="bg-white border border-[var(--color-border)] rounded-2xl p-[22px] shadow-sm"
          >
            <div className="flex items-start justify-between mb-3.5">
              <span className="text-[13px] font-medium text-[var(--color-text-secondary)]">
                {c.label}
              </span>
              <div
                className={`w-[38px] h-[38px] rounded-[10px] ${t.bg} ${t.fg} flex items-center justify-center`}
              >
                {c.icon}
              </div>
            </div>
            <div className="text-[26px] font-extrabold text-[var(--color-text)] tracking-tight">
              {c.value}
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              {c.deltaLabel && (
                <span
                  className={`text-[11px] ${t.bg} ${t.fg} px-2 py-[2px] rounded-full font-semibold`}
                >
                  {c.deltaLabel}
                </span>
              )}
              <span className="text-xs text-[var(--color-text-secondary)]">{c.delta}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
