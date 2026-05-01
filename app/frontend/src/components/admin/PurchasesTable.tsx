import { useMemo, useState } from "react";
import type { PurchaseResponse } from "../../api/purchases";

interface PurchasesTableProps {
  items: PurchaseResponse[];
  isLoading?: boolean;
}

type SortDir = "desc" | "asc";

function stripItemNo(name: string) {
  const m = name.match(/^\d+_(.+)$/);
  return m ? m[1] : name;
}

function csvEscape(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(rows: PurchaseResponse[]): string {
  const header = ["id", "user_id", "username", "items", "total_amount", "timestamp", "notes"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const itemsStr = r.items
      .map((it) => `${stripItemNo(it.name)}x${it.count}`)
      .join(" | ");
    lines.push(
      [
        csvEscape(r.id),
        csvEscape(r.user_id),
        csvEscape(r.username),
        csvEscape(itemsStr),
        csvEscape(r.total_amount ?? 0),
        csvEscape(r.timestamp),
        csvEscape(r.notes ?? ""),
      ].join(",")
    );
  }
  return lines.join("\n");
}

function downloadCsv(filename: string, csv: string) {
  const bom = "﻿";
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function PurchasesTable({ items, isLoading }: PurchasesTableProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? items.filter((p) => (p.username || "").toLowerCase().includes(q))
      : items;
    const sorted = [...list].sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return sort === "desc" ? tb - ta : ta - tb;
    });
    return sorted;
  }, [items, query, sort]);

  const onExport = () => {
    if (filtered.length === 0) return;
    const ts = new Date().toISOString().slice(0, 10);
    downloadCsv(`jangbogo_purchases_${ts}.csv`, buildCsv(filtered));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xl font-bold text-[var(--color-text)]">전체 구매 내역</div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            총 {items.length.toLocaleString("ko-KR")}건 · 검색 결과 {filtered.length.toLocaleString("ko-KR")}건
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="고객명 검색"
            className="px-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-white focus:outline-none focus:ring-2 focus:ring-orange-200 w-44"
          />
          <button
            type="button"
            onClick={() => setSort(sort === "desc" ? "asc" : "desc")}
            className="px-3 py-2 text-sm font-semibold rounded-lg border border-[var(--color-border)] bg-white text-slate-600 hover:bg-gray-50"
            title="구매 일시 정렬 토글"
          >
            시간 {sort === "desc" ? "↓" : "↑"}
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={filtered.length === 0}
            className="px-3 py-2 text-sm font-semibold rounded-lg border border-[var(--color-border)] bg-white text-slate-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            📥 CSV 내보내기
          </button>
        </div>
      </div>

      <div className="bg-white border border-[var(--color-border)] rounded-2xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-[var(--color-text-secondary)] text-sm">
            로딩 중...
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <div className="text-5xl mb-3">📊</div>
            <p className="text-sm text-[var(--color-text-secondary)]">
              구매 내역이 없습니다.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50 border-b border-[var(--color-border)]">
                  <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-600 uppercase tracking-wider">#</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-600 uppercase tracking-wider">고객</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-600 uppercase tracking-wider">상품</th>
                  <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-600 uppercase tracking-wider">시간</th>
                  <th className="px-4 py-3 text-right text-[11px] font-bold text-slate-600 uppercase tracking-wider">결제 금액</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const time = new Date(p.timestamp).toLocaleString("ko-KR", {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  const visible = p.items.slice(0, 3);
                  return (
                    <tr key={p.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 text-xs font-mono text-slate-400">#{p.id}</td>
                      <td className="px-4 py-3 text-[13px] font-semibold text-[var(--color-text)]">
                        {p.username}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {visible
                          .map((it) => `${stripItemNo(it.name)}×${it.count}`)
                          .join(", ")}
                        {p.items.length > 3 && ` +${p.items.length - 3}`}
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--color-text-secondary)]">
                        {time}
                      </td>
                      <td className="px-4 py-3 text-right text-[13px] font-bold text-[var(--color-primary)]">
                        ₩{(p.total_amount ?? 0).toLocaleString("ko-KR")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
