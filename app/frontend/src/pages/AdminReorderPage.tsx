import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import {
  getReorderSuggestions,
  createReorder,
  listReorders,
  updateReorderStatus,
  deleteReorder,
  type ReorderSuggestion,
  type ReorderItemPayload,
  type ReorderResponse,
} from "../api/reorder";

const STATUS_META: Record<string, { label: string; color: string; icon: string }> = {
  pending:   { label: "발주 대기",  color: "bg-amber-100 text-amber-700",  icon: "⏳" },
  ordered:   { label: "발주 완료",  color: "bg-blue-100 text-blue-700",    icon: "📦" },
  received:  { label: "입고 완료",  color: "bg-green-100 text-green-700",  icon: "✅" },
  cancelled: { label: "취소됨",     color: "bg-gray-100 text-gray-500",    icon: "✕"  },
};

const NEXT_ACTIONS: Record<string, { status: string; label: string; color: string }[]> = {
  pending: [
    { status: "ordered",   label: "발주 확정", color: "bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]" },
    { status: "cancelled", label: "취소",      color: "bg-red-100 text-red-600 hover:bg-red-200" },
  ],
  ordered: [
    { status: "received",  label: "입고 확인", color: "bg-green-500 text-white hover:bg-green-600" },
    { status: "cancelled", label: "취소",      color: "bg-red-100 text-red-600 hover:bg-red-200" },
  ],
  received:  [],
  cancelled: [],
};

const fmt = (v: number) => `₩${v.toLocaleString("ko-KR")}`;

export default function AdminReorderPage() {
  const { token } = useAuthStore();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"create" | "history">("create");
  const [cart, setCart] = useState<Map<string, { suggestion: ReorderSuggestion; quantity: number }>>(new Map());
  const [notes, setNotes] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const { data: suggestions = [], isLoading: loadingSuggestions } = useQuery({
    queryKey: ["reorder-suggestions"],
    queryFn: () => getReorderSuggestions(token!, 15),
    enabled: !!token,
  });

  const { data: reorders = [], isLoading: loadingHistory } = useQuery({
    queryKey: ["reorders"],
    queryFn: () => listReorders(token!),
    enabled: !!token,
  });

  function flashSuccess(msg: string) {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(""), 3000);
  }
  function flashError(msg: string) {
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(""), 4000);
  }

  function toggleItem(s: ReorderSuggestion) {
    setCart((prev) => {
      const next = new Map(prev);
      if (next.has(s.product_name)) {
        next.delete(s.product_name);
      } else {
        next.set(s.product_name, { suggestion: s, quantity: s.suggested_quantity });
      }
      return next;
    });
  }

  function setQty(name: string, qty: number) {
    if (qty < 1) return;
    setCart((prev) => {
      const next = new Map(prev);
      const entry = next.get(name);
      if (entry) next.set(name, { ...entry, quantity: qty });
      return next;
    });
  }

  function selectAll() {
    setCart(new Map(suggestions.map((s) => [s.product_name, { suggestion: s, quantity: s.suggested_quantity }])));
  }

  function clearCart() { setCart(new Map()); }

  const createMutation = useMutation({
    mutationFn: (items: ReorderItemPayload[]) =>
      createReorder(token!, { items, notes: notes.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reorders"] });
      clearCart();
      setNotes("");
      flashSuccess("발주가 성공적으로 생성되었습니다! 🎉");
      setTab("history");
    },
    onError: (e: Error) => flashError(`발주 실패: ${e.message}`),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      updateReorderStatus(token!, id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reorders"] }),
    onError: (e: Error) => flashError(`상태 변경 실패: ${e.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteReorder(token!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reorders"] });
      flashSuccess("발주가 삭제되었습니다.");
    },
    onError: (e: Error) => flashError(`삭제 실패: ${e.message}`),
  });

  function handleCreateReorder() {
    if (cart.size === 0) { flashError("발주할 상품을 1개 이상 선택해주세요."); return; }
    const items: ReorderItemPayload[] = Array.from(cart.values()).map(({ suggestion, quantity }) => ({
      product_name: suggestion.product_name,
      item_no: suggestion.item_no,
      quantity,
      unit_price: suggestion.unit_price,
    }));
    createMutation.mutate(items);
  }

  const cartEntries = Array.from(cart.values());
  const totalQty = cartEntries.reduce((s, e) => s + e.quantity, 0);
  const totalAmt = cartEntries.reduce((s, e) => s + e.quantity * (e.suggestion.unit_price ?? 0), 0);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-[var(--color-text)] mb-1">자동 발주</h1>
        <p className="text-[var(--color-text-secondary)]">판매량 기반으로 발주 상품을 추천받고 한 번에 발주하세요</p>
      </div>

      {successMsg && (
        <div className="mb-4 p-4 rounded-xl bg-green-50 border border-green-200 text-green-700 font-medium flex items-center gap-2">
          <span>✅</span> {successMsg}
        </div>
      )}
      {errorMsg && (
        <div className="mb-4 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 font-medium flex items-center gap-2">
          <span>❌</span> {errorMsg}
        </div>
      )}

      <div className="flex gap-2 mb-6 border-b border-[var(--color-border)]">
        {(["create", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-px ${
              tab === t
                ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            {t === "create" ? "📋 발주 생성" : "📜 발주 내역"}
          </button>
        ))}
      </div>

      {/* 탭1: 발주 생성 */}
      {tab === "create" && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2">
            <div className="bg-white rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
              <div className="p-5 border-b border-[var(--color-border)] flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">🏆 발주 추천 상품</h2>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">판매량 기준 상위 상품 · 추천 수량은 최근 판매량의 50%</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={selectAll} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--color-primary-light)] text-[var(--color-primary)] hover:bg-orange-200 transition-colors">전체 선택</button>
                  <button onClick={clearCart} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">초기화</button>
                </div>
              </div>

              {loadingSuggestions ? (
                <div className="text-center py-16 text-[var(--color-text-secondary)]">
                  <div className="text-4xl mb-3 animate-pulse">📦</div>
                  <p>판매 데이터 분석 중...</p>
                </div>
              ) : suggestions.length === 0 ? (
                <div className="text-center py-16 text-[var(--color-text-secondary)]">
                  <div className="text-4xl mb-3">📊</div>
                  <p>구매 데이터가 없습니다.</p>
                  <p className="text-xs mt-1">고객 구매 내역이 쌓이면 추천이 표시됩니다.</p>
                </div>
              ) : (
                <div className="divide-y divide-[var(--color-border)]">
                  {suggestions.map((s, idx) => {
                    const selected = cart.has(s.product_name);
                    const entry = cart.get(s.product_name);
                    return (
                      <div
                        key={s.product_name}
                        className={`flex items-center gap-4 px-5 py-4 transition-colors ${selected ? "bg-[var(--color-primary-light)]" : "hover:bg-gray-50"}`}
                      >
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${idx === 0 ? "bg-yellow-400 text-white" : idx === 1 ? "bg-gray-300 text-white" : idx === 2 ? "bg-amber-600 text-white" : "bg-gray-100 text-gray-500"}`}>
                          {idx + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-[var(--color-text)] truncate">{s.product_name}</p>
                          <div className="flex items-center gap-3 mt-0.5">
                            <span className="text-xs text-[var(--color-text-secondary)]">총 판매 {s.total_sold.toLocaleString()}개</span>
                            {s.unit_price != null && <span className="text-xs text-[var(--color-text-secondary)]">· 단가 {fmt(s.unit_price)}</span>}
                          </div>
                        </div>
                        {selected && entry && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button onClick={() => setQty(s.product_name, entry.quantity - 1)} className="w-7 h-7 rounded-lg bg-white border border-[var(--color-border)] hover:bg-gray-100 font-bold transition-colors">−</button>
                            <input
                              type="number"
                              min={1}
                              value={entry.quantity}
                              onChange={(e) => setQty(s.product_name, parseInt(e.target.value) || 1)}
                              className="w-14 h-7 text-center text-sm font-semibold border border-[var(--color-border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                            />
                            <button onClick={() => setQty(s.product_name, entry.quantity + 1)} className="w-7 h-7 rounded-lg bg-white border border-[var(--color-border)] hover:bg-gray-100 font-bold transition-colors">+</button>
                          </div>
                        )}
                        {!selected && <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-500 flex-shrink-0">추천 {s.suggested_quantity}개</span>}
                        <button
                          onClick={() => toggleItem(s)}
                          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors flex-shrink-0 ${selected ? "bg-[var(--color-primary)] text-white" : "bg-gray-100 text-gray-400 hover:bg-gray-200"}`}
                        >
                          {selected ? "✓" : "+"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 발주 요약 */}
          <div className="xl:col-span-1">
            <div className="bg-white rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden sticky top-6">
              <div className="p-5 border-b border-[var(--color-border)]">
                <h2 className="text-lg font-semibold text-[var(--color-text)]">🛒 발주 요약</h2>
              </div>
              <div className="p-5">
                {cart.size === 0 ? (
                  <div className="text-center py-8 text-[var(--color-text-secondary)]">
                    <div className="text-4xl mb-2">📋</div>
                    <p className="text-sm">왼쪽에서 상품을 선택하세요</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {cartEntries.map(({ suggestion: s, quantity }) => (
                        <div key={s.product_name} className="flex items-start justify-between gap-2 p-2.5 bg-[var(--color-primary-light)] rounded-xl">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-[var(--color-text)] truncate">{s.product_name}</p>
                            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                              {quantity}개{s.unit_price != null && ` · ${fmt(quantity * s.unit_price)}`}
                            </p>
                          </div>
                          <button onClick={() => toggleItem(s)} className="text-gray-400 hover:text-red-500 transition-colors text-xs mt-0.5 flex-shrink-0">✕</button>
                        </div>
                      ))}
                    </div>
                    <div className="pt-3 border-t border-[var(--color-border)] space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-[var(--color-text-secondary)]">총 상품 종류</span>
                        <span className="font-semibold">{cart.size}종</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-[var(--color-text-secondary)]">총 수량</span>
                        <span className="font-semibold">{totalQty.toLocaleString()}개</span>
                      </div>
                      {totalAmt > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-[var(--color-text-secondary)]">예상 금액</span>
                          <span className="font-bold text-[var(--color-primary)]">{fmt(totalAmt)}</span>
                        </div>
                      )}
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">발주 메모 (선택)</label>
                      <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="ex) 긴급 발주, 행사 대비..."
                        rows={2}
                        className="w-full text-sm border border-[var(--color-border)] rounded-xl p-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                      />
                    </div>
                    <button
                      onClick={handleCreateReorder}
                      disabled={createMutation.isPending}
                      className="w-full py-3 rounded-xl bg-[var(--color-primary)] text-white font-semibold text-sm hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {createMutation.isPending ? <><span className="animate-spin">⟳</span> 처리 중...</> : <>📦 발주 생성하기</>}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 탭2: 발주 내역 */}
      {tab === "history" && (
        <div className="bg-white rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
          <div className="p-5 border-b border-[var(--color-border)]">
            <h2 className="text-lg font-semibold text-[var(--color-text)]">📜 발주 내역</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">발주 확정 → 입고 확인 순서로 상태를 업데이트하세요</p>
          </div>
          {loadingHistory ? (
            <div className="text-center py-16 text-[var(--color-text-secondary)]"><div className="text-4xl mb-3 animate-pulse">📜</div><p>불러오는 중...</p></div>
          ) : reorders.length === 0 ? (
            <div className="text-center py-16 text-[var(--color-text-secondary)]">
              <div className="text-4xl mb-3">📋</div>
              <p>발주 내역이 없습니다.</p>
              <button onClick={() => setTab("create")} className="mt-3 text-sm text-[var(--color-primary)] hover:underline">첫 발주 생성하기 →</button>
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {reorders.map((r) => (
                <ReorderCard
                  key={r.id}
                  reorder={r}
                  onStatusChange={(status) => statusMutation.mutate({ id: r.id, status })}
                  onDelete={() => deleteMutation.mutate(r.id)}
                  isUpdating={statusMutation.isPending || deleteMutation.isPending}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReorderCard({ reorder, onStatusChange, onDelete, isUpdating }: {
  reorder: ReorderResponse;
  onStatusChange: (status: string) => void;
  onDelete: () => void;
  isUpdating: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[reorder.status] ?? STATUS_META.cancelled;
  const actions = NEXT_ACTIONS[reorder.status] ?? [];

  return (
    <div className="p-5">
      <div className="flex flex-wrap items-start gap-3 justify-between">
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${meta.color}`}>
            {meta.icon} {meta.label}
          </span>
          <span className="text-sm font-semibold text-[var(--color-text)]">발주 #{reorder.id}</span>
          <span className="text-xs text-[var(--color-text-secondary)]">{new Date(reorder.created_at).toLocaleString("ko-KR")}</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-[var(--color-text-secondary)]">{reorder.items.length}종 · 총 {reorder.total_quantity.toLocaleString()}개</span>
          {reorder.total_amount > 0 && <span className="font-bold text-[var(--color-primary)]">{fmt(reorder.total_amount)}</span>}
        </div>
      </div>

      {reorder.notes && (
        <p className="mt-2 text-xs text-[var(--color-text-secondary)] bg-gray-50 rounded-lg px-3 py-2">💬 {reorder.notes}</p>
      )}

      <button onClick={() => setExpanded((v) => !v)} className="mt-3 text-xs text-[var(--color-primary)] hover:underline">
        {expanded ? "▲ 접기" : `▼ 상품 ${reorder.items.length}개 보기`}
      </button>

      {expanded && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {reorder.items.map((item, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-xl text-xs">
              <span className="font-medium text-[var(--color-text)] truncate max-w-[60%]">{item.product_name}</span>
              <div className="text-right text-[var(--color-text-secondary)] flex-shrink-0 ml-2">
                <span className="font-semibold text-[var(--color-text)]">{item.quantity}개</span>
                {item.unit_price != null && <span className="ml-1">· {fmt(item.quantity * item.unit_price)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {(actions.length > 0 || reorder.status === "pending") && (
        <div className="mt-4 flex flex-wrap gap-2">
          {actions.map((a) => (
            <button key={a.status} onClick={() => onStatusChange(a.status)} disabled={isUpdating}
              className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50 ${a.color}`}>
              {a.label}
            </button>
          ))}
          {reorder.status === "pending" && (
            <button onClick={onDelete} disabled={isUpdating}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-500 transition-colors disabled:opacity-50">
              🗑 삭제
            </button>
          )}
        </div>
      )}
    </div>
  );
}