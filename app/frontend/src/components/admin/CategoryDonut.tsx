import { useMemo } from "react";
import type { PurchaseResponse } from "../../api/purchases";

interface CategoryDonutProps {
  purchases: PurchaseResponse[];
}

const COLORS = [
  "#f97316",
  "#fbbf24",
  "#2563eb",
  "#16a34a",
  "#7c3aed",
  "#ef4444",
  "#64748b",
];

const NAME_KEYWORD_TO_CATEGORY: Array<[RegExp, string]> = [
  [/스팸|라면|즉석|만두|국|찌개|밀키트|컵밥|도시락|간편식|분말|소스|식초|장류|기름|식용유/, "가공식품"],
  [/한우|등심|삼겹|목살|돼지|소고기|닭고기|불고기|갈비|정육/, "정육"],
  [/우유|요거트|요플레|치즈|버터|크림|유제품/, "유제품"],
  [/초코|과자|쿠키|비스킷|크래커|새우깡|꼬깔콘|파이|껌|사탕|젤리|초콜릿/, "과자"],
  [/콜라|사이다|주스|음료|커피|차|음료수|생수|에이드|맥주|소주|와인/, "음료"],
  [/냉장|냉동|아이스크림|빙과|샐러드|반찬|김치|두부|어묵/, "냉장/냉동"],
  [/사과|배|딸기|포도|바나나|토마토|상추|배추|무|당근|양파|채소|과일/, "농산"],
  [/생선|고등어|갈치|연어|새우|문어|오징어|수산|회/, "수산"],
];

function categorizeByName(name: string): string {
  const trimmed = name.replace(/^\d+_/, "");
  for (const [pattern, label] of NAME_KEYWORD_TO_CATEGORY) {
    if (pattern.test(trimmed)) return label;
  }
  return "기타";
}

function compactKRW(value: number): string {
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}억`;
  if (value >= 10000) return `${Math.round(value / 10000)}만`;
  if (value >= 1000) return `${Math.round(value / 1000)}천`;
  return `${value}`;
}

export default function CategoryDonut({ purchases }: CategoryDonutProps) {
  const segments = useMemo(() => {
    const totals: Record<string, number> = {};
    purchases.forEach((p) => {
      p.items.forEach((it) => {
        const cat = categorizeByName(it.name);
        const rev =
          it.line_total ??
          (it.unit_price ?? 0) * (it.count ?? 0);
        totals[cat] = (totals[cat] || 0) + rev;
      });
    });
    return Object.entries(totals)
      .map(([cat, v]) => ({ cat, v }))
      .sort((a, b) => b.v - a.v);
  }, [purchases]);

  const grand = segments.reduce((s, x) => s + x.v, 0) || 1;

  const R = 70;
  const r = 44;
  const cx = 90;
  const cy = 90;
  let a0 = -Math.PI / 2;

  const segs = segments.map((t, i) => {
    const frac = t.v / grand;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + R * Math.cos(a0);
    const y0 = cy + R * Math.sin(a0);
    const x1 = cx + R * Math.cos(a1);
    const y1 = cy + R * Math.sin(a1);
    const xi0 = cx + r * Math.cos(a0);
    const yi0 = cy + r * Math.sin(a0);
    const xi1 = cx + r * Math.cos(a1);
    const yi1 = cy + r * Math.sin(a1);
    const path = `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${r} ${r} 0 ${large} 0 ${xi0} ${yi0} Z`;
    a0 = a1;
    return { path, cat: t.cat, v: t.v, frac, color: COLORS[i % COLORS.length] };
  });

  return (
    <div className="bg-white border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
      <div className="mb-3.5">
        <div className="text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
          <span>🥧</span>카테고리별 매출 구성
        </div>
        <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
          최근 구매 기준 · 대분류별 매출 비중
        </div>
      </div>

      {segments.length === 0 ? (
        <div className="h-32 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
          최근 구매 데이터가 없습니다.
        </div>
      ) : (
        <div className="flex items-center gap-5">
          <svg width="180" height="180" viewBox="0 0 180 180" className="flex-shrink-0">
            {segs.map((s, i) => (
              <path key={i} d={s.path} fill={s.color} />
            ))}
            <text x={cx} y={cy - 2} textAnchor="middle" fontSize={11} fill="#94a3b8">
              총 매출
            </text>
            <text
              x={cx}
              y={cy + 16}
              textAnchor="middle"
              fontSize={13}
              fontWeight={700}
              fill="#0f172a"
            >
              ₩{compactKRW(grand)}
            </text>
          </svg>
          <div className="flex-1 flex flex-col gap-2">
            {segs.map((s) => (
              <div key={s.cat} className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                  style={{ background: s.color }}
                />
                <span className="text-xs font-semibold text-[var(--color-text)] flex-1">
                  {s.cat}
                </span>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {(s.frac * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
