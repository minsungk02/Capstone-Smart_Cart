import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import type { PurchaseResponse } from "../api/purchases";

interface Props {
  purchases: PurchaseResponse[];
}

export default function PurchaseCharts({ purchases }: Props) {
  const itemTotals: Record<string, number> = {};
  for (const purchase of purchases) {
    for (const item of purchase.items) {
      itemTotals[item.name] = (itemTotals[item.name] ?? 0) + item.count;
    }
  }
  const topItems = Object.entries(itemTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  const dailyTotals: Record<string, number> = {};
  for (const purchase of purchases) {
    const date = new Date(purchase.timestamp).toLocaleDateString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
    });
    dailyTotals[date] = (dailyTotals[date] ?? 0) + (purchase.total_amount ?? 0);
  }
  const spendingByDate = Object.entries(dailyTotals)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, amount]) => ({ date, amount }));

  if (topItems.length === 0) return null;

  return (
    <div className="space-y-6 mb-8">
      {/* 품목별 누적 구매 수량 */}
      <div className="bg-white rounded-2xl shadow-sm border border-[var(--color-border)] p-6">
        <h2 className="text-xl font-semibold text-[var(--color-text)] mb-6">
          많이 구매한 품목
        </h2>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart
            data={topItems}
            layout="vertical"
            margin={{ top: 0, right: 24, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
            <YAxis
              type="category"
              dataKey="name"
              width={100}
              tick={{ fontSize: 12 }}
            />
            <Tooltip
              formatter={(value: number) => [`${value}개`, "구매 수량"]}
            />
            <Bar dataKey="count" fill="var(--color-primary)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* 날짜별 지출 추이 */}
      {spendingByDate.length > 1 && (
        <div className="bg-white rounded-2xl shadow-sm border border-[var(--color-border)] p-6">
          <h2 className="text-xl font-semibold text-[var(--color-text)] mb-6">
            날짜별 지출 추이
          </h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={spendingByDate}
              margin={{ top: 0, right: 24, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis
                tick={{ fontSize: 12 }}
                tickFormatter={(v: number) => `₩${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip
                formatter={(value: number) =>
                  [`₩${value.toLocaleString("ko-KR")}`, "지출액"]
                }
              />
              <Line
                type="monotone"
                dataKey="amount"
                stroke="var(--color-primary)"
                strokeWidth={2}
                dot={{ r: 4 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
