import { useState } from "react";
import type { DashboardStats } from "../../api/purchases";

type DailyStat = DashboardStats["daily_stats"][number];

export type TrendMetric = "revenue" | "count";

interface TrendChartProps {
  data: DailyStat[];
  metric: TrendMetric;
  onMetricChange: (m: TrendMetric) => void;
}

export default function TrendChart({ data, metric, onMetricChange }: TrendChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="bg-white border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
        <div className="text-lg font-bold text-[var(--color-text)]">일별 추이</div>
        <div className="mt-6 h-64 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
          최근 차트 데이터가 없습니다.
        </div>
      </div>
    );
  }

  const w = 820;
  const h = 260;
  const pad = { t: 24, r: 28, b: 40, l: 56 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  const key: keyof DailyStat = metric === "revenue" ? "revenue" : "purchase_count";
  const vals = data.map((d) => d[key] as number);
  const maxY = Math.max(1, Math.max(...vals) * 1.12);
  const minY = 0;

  const xAt = (i: number) =>
    pad.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const yAt = (v: number) =>
    pad.t + ih - ((v - minY) / (maxY - minY)) * ih;

  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(2)} ${yAt(d[key] as number).toFixed(2)}`)
    .join(" ");
  const areaPath =
    linePath +
    ` L ${xAt(data.length - 1).toFixed(2)} ${pad.t + ih} L ${xAt(0).toFixed(2)} ${pad.t + ih} Z`;

  const gridLines = 4;
  const ticks = Array.from(
    { length: gridLines + 1 },
    (_, i) => minY + (maxY - minY) * (i / gridLines)
  );

  const fmtY = (v: number) =>
    metric === "revenue"
      ? `₩${
          v >= 10000
            ? `${(v / 10000).toFixed(v >= 1000000 ? 0 : 1)}만`
            : v.toFixed(0)
        }`
      : `${Math.round(v)}건`;

  const fmtDate = (iso: string) => iso.slice(5).replace("-", "/");

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = w / rect.width;
    const x = (e.clientX - rect.left) * scale;
    if (x < pad.l || x > pad.l + iw) {
      setHover(null);
      return;
    }
    const relX = (x - pad.l) / iw;
    const idx = Math.min(
      data.length - 1,
      Math.max(0, Math.round(relX * (data.length - 1)))
    );
    setHover(idx);
  };

  const hoverData = hover != null ? data[hover] : null;

  return (
    <div className="bg-white border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div>
          <div className="text-lg font-bold text-[var(--color-text)]">일별 추이</div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            {hoverData ? (
              <>
                <b className="text-[var(--color-text)]">{fmtDate(hoverData.date)}</b>{" · "}
                매출 ₩{hoverData.revenue.toLocaleString("ko-KR")}{" · "}
                구매 {hoverData.purchase_count}건
              </>
            ) : (
              `${data.length}일간 ${metric === "revenue" ? "매출" : "구매 건수"} 추이`
            )}
          </div>
        </div>
        <div className="inline-flex items-center rounded-lg border border-[var(--color-border)] p-[2px] bg-[var(--color-bg)]">
          {(["revenue", "count"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onMetricChange(v)}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                metric === v
                  ? "bg-white text-[var(--color-text)] shadow-sm"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              {v === "revenue" ? "매출" : "건수"}
            </button>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-auto block"
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="trendAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#f97316" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={pad.l}
              x2={pad.l + iw}
              y1={yAt(t)}
              y2={yAt(t)}
              stroke="#f1f5f9"
              strokeWidth={1}
            />
            <text
              x={pad.l - 10}
              y={yAt(t) + 4}
              textAnchor="end"
              fontSize={10}
              fill="#94a3b8"
            >
              {fmtY(t)}
            </text>
          </g>
        ))}

        {metric === "count" &&
          data.map((d, i) => {
            const bw = Math.max(6, (iw / data.length) * 0.55);
            const x = xAt(i) - bw / 2;
            const y = yAt(d.purchase_count);
            const bh = pad.t + ih - y;
            const isHover = hover === i;
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={bw}
                height={bh}
                rx={4}
                fill={isHover ? "#ea580c" : "#fdba74"}
              />
            );
          })}

        {metric === "revenue" && (
          <>
            <path d={areaPath} fill="url(#trendAreaGrad)" />
            <path
              d={linePath}
              fill="none"
              stroke="#f97316"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {data.map((d, i) => {
              const isHover = hover === i;
              return (
                <circle
                  key={i}
                  cx={xAt(i)}
                  cy={yAt(d.revenue)}
                  r={isHover ? 5 : 3}
                  fill="#fff"
                  stroke="#f97316"
                  strokeWidth={isHover ? 3 : 2}
                />
              );
            })}
          </>
        )}

        {hover != null && (
          <line
            x1={xAt(hover)}
            x2={xAt(hover)}
            y1={pad.t}
            y2={pad.t + ih}
            stroke="#cbd5e1"
            strokeDasharray="3 3"
            strokeWidth={1}
          />
        )}

        {data.map((d, i) => {
          const step =
            data.length > 14 ? Math.ceil(data.length / 7) : data.length > 7 ? 2 : 1;
          if (i % step !== 0 && i !== data.length - 1) return null;
          return (
            <text
              key={i}
              x={xAt(i)}
              y={pad.t + ih + 18}
              textAnchor="middle"
              fontSize={10}
              fill="#94a3b8"
            >
              {fmtDate(d.date)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
