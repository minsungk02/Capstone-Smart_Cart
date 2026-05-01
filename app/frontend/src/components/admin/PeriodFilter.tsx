interface PeriodFilterProps {
  value: number;
  onChange: (value: number) => void;
}

const OPTIONS = [
  { v: 7, l: "최근 7일" },
  { v: 14, l: "최근 14일" },
  { v: 30, l: "최근 30일" },
] as const;

export default function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  return (
    <div className="inline-flex items-center rounded-lg border border-[var(--color-border)] bg-white p-[3px]">
      {OPTIONS.map((o) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition-colors ${
              active
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text-secondary)] hover:bg-gray-50"
            }`}
          >
            {o.l}
          </button>
        );
      })}
    </div>
  );
}
