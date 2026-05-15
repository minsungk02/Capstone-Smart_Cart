interface Props {
  lastLabel: string;
  lastScore: number;
  lastStatus: string;
  fps?: number;
  trackId?: string | null;
}

export default function StatusMetrics({
  lastLabel,
  lastScore,
  lastStatus,
  trackId,
}: Props) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {/* Last Recognition */}
      <div className="bg-white rounded-xl p-4 border border-[var(--color-border)]">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xl">🕐</span>
          <span className="text-xs text-[var(--color-text-secondary)] font-medium">
            최근 인식
          </span>
        </div>
        <p className="text-xl font-bold text-[var(--color-text)]">
          {lastLabel || "-"}
        </p>
      </div>

      {/* Similarity */}
      <div className="bg-white rounded-xl p-4 border border-[var(--color-border)]">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xl">📊</span>
          <span className="text-xs text-[var(--color-text-secondary)] font-medium">
            유사도
          </span>
        </div>
        <p className="text-xl font-bold text-[var(--color-secondary)]">
          {lastScore > 0 ? `${Math.round(lastScore * 100)}%` : "-"}
        </p>
      </div>

      {/* Status */}
      <div className="bg-white rounded-xl p-4 border border-[var(--color-border)]">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xl">✅</span>
          <span className="text-xs text-[var(--color-text-secondary)] font-medium">
            상태
          </span>
        </div>
        <p className="text-xl font-bold text-[var(--color-success)]">
          {lastStatus || "대기중"}
        </p>
      </div>

      {/* Track ID */}
      <div className="bg-white rounded-xl p-4 border border-[var(--color-border)]">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xl">🔍</span>
          <span className="text-xs text-[var(--color-text-secondary)] font-medium">
            Track ID
          </span>
        </div>
        <p className="text-xl font-bold text-[var(--color-text)]">
          {trackId ?? "-"}
        </p>
      </div>
    </div>
  );
}
