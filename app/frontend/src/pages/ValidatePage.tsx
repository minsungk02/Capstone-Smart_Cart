import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionStore } from "../stores/sessionStore";
import { useAuthStore } from "../stores/authStore";
import { confirmBilling, getBilling, updateBilling } from "../api/checkout";
import { createPurchase } from "../api/purchases";

type PaymentMethod = "card" | "easy" | "account";

const PAYMENT_METHOD_OPTIONS: Array<{ value: PaymentMethod; label: string; desc: string }> = [
  { value: "card", label: "카드 결제", desc: "국내/해외 신용카드" },
  { value: "easy", label: "간편 결제", desc: "토스페이/네이버페이" },
  { value: "account", label: "계좌 이체", desc: "실시간 계좌이체" },
];

type ReceiptLine = { name: string; qty: number; lineTotal: number };
type ReceiptData = {
  items: ReceiptLine[];
  total: number;
  when: string;
  receiptId: string;
};

function ReceiptView({ data, onDone }: { data: ReceiptData; onDone: () => void }) {
  const tax = Math.round(data.total * 0.1);
  const subtotal = data.total - tax;
  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-[var(--color-bg)] px-4 py-6">
      <div className="max-w-md mx-auto">
        <div className="bg-white rounded-[18px] border border-[var(--color-border)] overflow-hidden shadow-[var(--shadow-lg)]">
          <div
            className="px-5 pt-5 pb-4 text-center"
            style={{ background: "linear-gradient(135deg,#fff7ed,#ffedd5)" }}
          >
            <div className="w-[52px] h-[52px] rounded-[14px] bg-white mx-auto mb-2 flex items-center justify-center shadow-[0_4px_10px_rgba(249,115,22,0.15)]">
              <img src="/jangbogo.svg" alt="" className="w-9 h-9 rounded-lg" />
            </div>
            <div className="font-serif text-[20px] font-semibold text-slate-900 tracking-tight">
              영수증
            </div>
            <div className="text-[12px] text-amber-900/80 mt-0.5">{data.when}</div>
          </div>

          <div className="px-5 py-3.5">
            {data.items.map((i) => (
              <div
                key={i.name}
                className="flex justify-between py-2 text-sm"
              >
                <div className="text-slate-900">
                  {i.name} <span className="text-slate-400">× {i.qty}</span>
                </div>
                <div className="text-slate-900 font-semibold">
                  ₩{i.lineTotal.toLocaleString()}
                </div>
              </div>
            ))}
          </div>

          <div className="mx-5 border-t-[1.5px] border-dashed border-slate-300" />

          <div className="px-5 py-3.5 space-y-1">
            <div className="flex justify-between text-[13px] text-slate-500">
              <span>소계</span>
              <span>₩{subtotal.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-[13px] text-slate-500 mb-2">
              <span>부가세 (10%)</span>
              <span>₩{tax.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-lg font-bold text-slate-900">
              <span>합계</span>
              <span className="text-[var(--color-primary)]">
                ₩{data.total.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="mx-5 border-t-[1.5px] border-dashed border-slate-300" />

          <div className="px-5 py-4 text-center text-[12px] text-slate-400 leading-relaxed">
            영수증 #{data.receiptId}
            <br />
            장보GO에서 담아주셔서 감사합니다 🙌
          </div>
        </div>

        <button
          onClick={onDone}
          className="w-full mt-4 py-3.5 rounded-[14px] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-[16px] font-bold transition-colors shadow-[0_6px_20px_rgba(249,115,22,0.25)]"
        >
          장보기 완료
        </button>
      </div>
    </div>
  );
}

export default function ValidatePage() {
  const navigate = useNavigate();
  const [isConfirming, setIsConfirming] = useState(false);
  const [updatingItem, setUpdatingItem] = useState<string | null>(null);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isPreparingPayment, setIsPreparingPayment] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [payerName, setPayerName] = useState("");
  const [payerPhone, setPayerPhone] = useState("");
  const [isPaymentAgreed, setIsPaymentAgreed] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const { token } = useAuthStore();
  const {
    sessionId,
    billingItems,
    itemScores,
    itemUnitPrices,
    itemLineTotals,
    totalCount,
    totalAmount,
    currency,
    unpricedItems,
    setBillingState,
    resetSession,
  } = useSessionStore();

  const entries = Object.entries(billingItems).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const itemCount = entries.length;
  const formatAmount = (value: number) => `₩${value.toLocaleString("ko-KR")}`;

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    const syncPricing = async () => {
      try {
        const state = await getBilling(sessionId);
        if (!cancelled) {
          setBillingState(state);
        }
      } catch (error) {
        console.warn("Failed to load billing prices:", error);
      }
    };

    syncPricing();
    return () => {
      cancelled = true;
    };
  }, [sessionId, setBillingState]);

  const handleQtyChange = useCallback(
    async (name: string, delta: number) => {
      if (!sessionId || isConfirming) return;
      setUpdatingItem(name);
      try {
        const updated = { ...billingItems };
        const newQty = (updated[name] ?? 0) + delta;
        if (newQty <= 0) {
          delete updated[name];
        } else {
          updated[name] = newQty;
        }
        const result = await updateBilling(sessionId, updated);
        setBillingState(result);
      } catch (error) {
        console.error("Quantity update failed:", error);
        alert("수량 변경 중 오류가 발생했습니다.");
      } finally {
        setUpdatingItem(null);
      }
    },
    [sessionId, billingItems, setBillingState, isConfirming],
  );

  const handleConfirm = useCallback(async (paymentInfo?: { method: PaymentMethod; name: string; phone: string }) => {
    if (!sessionId || !token || isConfirming) return;

    let purchaseSaved = false;
    try {
      setIsConfirming(true);

      // Create purchase record
      const items = Object.entries(billingItems).map(([name, count]) => ({
        name,
        count,
      }));

      const created = await createPurchase(token, {
        session_id: sessionId,
        items,
        notes: paymentInfo
          ? `payment_method=${paymentInfo.method}; payer=${paymentInfo.name}; phone=${paymentInfo.phone}`
          : undefined,
      });
      purchaseSaved = true;

      // Snapshot receipt data before session reset clears it.
      const receiptItems: ReceiptLine[] = Object.entries(billingItems)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, qty]) => ({
          name,
          qty,
          lineTotal: itemLineTotals[name] ?? (itemUnitPrices[name] ?? 0) * qty,
        }));

      // Confirm billing
      const confirmed = await confirmBilling(sessionId);
      const finalAmount =
        confirmed.confirmed_total_amount ?? created.total_amount;

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const when = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const receiptId = `R-${1024 + Math.floor(Math.random() * 900)}`;

      resetSession();
      setReceipt({
        items: receiptItems,
        total: finalAmount,
        when,
        receiptId,
      });
    } catch (error) {
      console.error("Purchase confirmation failed:", error);
      if (purchaseSaved) {
        alert("구매 내역 저장은 완료됐지만 세션 정리 중 오류가 발생했습니다. 새로고침 후 내역을 확인해주세요.");
        navigate("/mypage");
        return;
      }
      alert("구매 확정 중 오류가 발생했습니다.");
    } finally {
      setIsConfirming(false);
    }
  }, [
    sessionId,
    token,
    billingItems,
    itemLineTotals,
    itemUnitPrices,
    resetSession,
    navigate,
    isConfirming,
  ]);

  const openPaymentModal = useCallback(() => {
    if (entries.length === 0 || isConfirming) return;
    setIsPaymentModalOpen(true);
  }, [entries.length, isConfirming]);

  const closePaymentModal = useCallback(() => {
    if (isConfirming || isPreparingPayment) return;
    setIsPaymentModalOpen(false);
  }, [isConfirming, isPreparingPayment]);

  useEffect(() => {
    if (!isPaymentModalOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePaymentModal();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [isPaymentModalOpen, closePaymentModal]);

  const handlePaymentSubmit = useCallback(async () => {
    if (isConfirming || isPreparingPayment) return;
    if (!payerName.trim()) {
      alert("결제자 이름을 입력해주세요.");
      return;
    }
    if (!payerPhone.trim()) {
      alert("연락처를 입력해주세요.");
      return;
    }
    if (!isPaymentAgreed) {
      alert("결제 진행을 위해 약관 동의가 필요합니다.");
      return;
    }

    try {
      setIsPreparingPayment(true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      setIsPaymentModalOpen(false);
      await handleConfirm({
        method: paymentMethod,
        name: payerName.trim(),
        phone: payerPhone.trim(),
      });
    } finally {
      setIsPreparingPayment(false);
    }
  }, [
    isConfirming,
    isPreparingPayment,
    payerName,
    payerPhone,
    isPaymentAgreed,
    paymentMethod,
    handleConfirm,
  ]);

  if (receipt) {
    return <ReceiptView data={receipt} onDone={() => navigate("/")} />;
  }

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg)]">
      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto p-4 md:p-6 lg:p-8 space-y-4 md:space-y-6">
          {/* Header */}
          <div className="bg-white rounded-xl md:rounded-2xl p-4 md:p-6 border border-[var(--color-border)] shadow-sm">
            <div className="flex items-start gap-3 md:gap-4">
              <div className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-[var(--color-secondary-light)] flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-6 h-6 md:w-7 md:h-7 text-[var(--color-secondary)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.5}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <div>
                <h2 className="font-serif text-2xl md:text-3xl font-semibold text-[var(--color-text)] mb-1 md:mb-2 tracking-tight">
                  영수증 확인
                </h2>
                <p className="text-sm md:text-base text-[var(--color-text-secondary)]">
                  상품 목록을 확인하고 수정하세요
                </p>
              </div>
            </div>
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-2 gap-3 md:gap-4">
            {/* Total Items */}
            <div className="bg-white rounded-xl md:rounded-2xl p-4 md:p-6 border border-[var(--color-border)] shadow-sm">
              <div className="flex items-center gap-2 md:gap-3 mb-2 md:mb-3">
                <div className="w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-[var(--color-primary-light)] flex items-center justify-center">
                  <span className="text-xl md:text-2xl">📦</span>
                </div>
                <span className="text-xs md:text-sm text-[var(--color-text-secondary)]">
                  총 상품 수
                </span>
              </div>
              <div className="text-2xl md:text-3xl font-bold text-[var(--color-text)]">
                {totalCount}개
              </div>
            </div>

            {/* Product Types */}
            <div className="bg-white rounded-xl md:rounded-2xl p-4 md:p-6 border border-[var(--color-border)] shadow-sm">
              <div className="flex items-center justify-between mb-2 md:mb-3">
                <div className="flex items-center gap-2 md:gap-3">
                  <div className="w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-[var(--color-secondary-light)] flex items-center justify-center">
                    <span className="text-xl md:text-2xl">💰</span>
                  </div>
                  <span className="text-xs md:text-sm text-[var(--color-text-secondary)]">
                    예상 결제금액
                  </span>
                </div>
                {itemCount > 0 && (
                  <span className="px-2 py-0.5 md:px-3 md:py-1 bg-[var(--color-primary-light)] text-[var(--color-primary)] text-xs font-semibold rounded-full">
                    검수 가능
                  </span>
                )}
              </div>
              <div className="text-2xl md:text-3xl font-bold text-[var(--color-text)]">
                {formatAmount(totalAmount)}
              </div>
              {currency !== "KRW" && (
                <div className="text-xs text-[var(--color-text-secondary)] mt-1">
                  통화: {currency}
                </div>
              )}
            </div>
          </div>

          {unpricedItems.length > 0 && (
            <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl px-4 py-3 text-sm">
              가격 미확인 품목 {unpricedItems.length}개가 있어 일부 금액이 0원으로 계산됩니다.
            </div>
          )}

          {/* Product List */}
          <div className="bg-white rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-2">
                <span className="text-xl">📋</span>
                <h3 className="text-lg font-bold text-[var(--color-text)]">
                  상품 목록
                </h3>
              </div>
              <span className="px-3 py-1 bg-[var(--color-primary-light)] text-[var(--color-primary)] text-sm font-semibold rounded-full">
                {itemCount}개 품목
              </span>
            </div>

            {/* Empty State or Product List */}
            {entries.length === 0 ? (
              <div className="p-12 text-center space-y-4">
                <div className="w-24 h-24 mx-auto bg-gray-100 rounded-2xl flex items-center justify-center">
                  <span className="text-5xl">🧾</span>
                </div>
                <div>
                  <p className="text-lg font-semibold text-[var(--color-text)] mb-2">
                    아직 확인할 상품이 없습니다
                  </p>
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    체크아웃 페이지에서 상품을 먼저 인식해주세요.
                  </p>
                </div>
                <button
                  onClick={() => navigate("/checkout")}
                  className="px-6 py-3 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-xl font-semibold transition-colors shadow-sm"
                >
                  체크아웃으로 이동
                </button>
              </div>
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {entries.map(([name, qty]) => (
                  <div
                    key={name}
                    className="p-6 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="font-semibold text-[var(--color-text)]">
                            {name}
                          </span>
                          <span className="px-2 py-0.5 bg-[var(--color-secondary-light)] text-[var(--color-secondary)] text-xs font-medium rounded">
                            {((itemScores[name] ?? 0) * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="text-sm text-[var(--color-text-secondary)]">
                          유사도: {(itemScores[name] ?? 0).toFixed(3)}
                        </p>
                        <p className="text-sm text-[var(--color-text-secondary)]">
                          단가: {itemUnitPrices[name] == null ? "미확인" : formatAmount(itemUnitPrices[name] as number)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-24 text-right">
                          <p className="text-sm font-bold text-[var(--color-text)]">
                            {formatAmount(itemLineTotals[name] ?? 0)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 bg-gray-100 rounded-lg p-1">
                          <button
                            onClick={() => handleQtyChange(name, -1)}
                            disabled={isConfirming || updatingItem === name}
                            className="w-8 h-8 rounded-lg hover:bg-white text-lg font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            -
                          </button>
                          <span className="w-10 text-center font-bold text-[var(--color-text)]">
                            {qty}
                          </span>
                          <button
                            onClick={() => handleQtyChange(name, 1)}
                            disabled={isConfirming || updatingItem === name}
                            className="w-8 h-8 rounded-lg hover:bg-white text-lg font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            +
                          </button>
                        </div>
                        <button
                          onClick={() => handleQtyChange(name, -qty)}
                          disabled={isConfirming || updatingItem === name}
                          className="px-4 py-2 text-sm text-[var(--color-danger)] hover:bg-red-50 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          삭제
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-[var(--color-border)] bg-white">
        <div className="max-w-4xl mx-auto p-4 md:p-6">
          <div className="flex items-center justify-between mb-3 md:mb-4">
            <span className="text-base md:text-lg font-semibold text-[var(--color-text)]">
              예상 결제금액
            </span>
            <span className="text-3xl md:text-4xl font-bold text-[var(--color-primary)]">
              {formatAmount(totalAmount)}
            </span>
          </div>
          <div className="flex gap-2 md:gap-3">
            <button
              onClick={() => navigate("/checkout")}
              disabled={isConfirming}
              className="flex-1 px-4 py-3 md:px-6 md:py-4 bg-white hover:bg-gray-50 border-2 border-[var(--color-border)] text-[var(--color-text)] rounded-lg md:rounded-xl text-sm md:text-base font-semibold transition-colors"
            >
              취소
            </button>
            <button
              onClick={openPaymentModal}
              disabled={entries.length === 0 || isConfirming}
              className="flex-1 px-4 py-3 md:px-6 md:py-4 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg md:rounded-xl text-sm md:text-base font-semibold transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isConfirming ? "처리 중..." : "결제하기"}
            </button>
          </div>
        </div>
      </div>

      {isPaymentModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closePaymentModal();
            }
          }}
        >
          <div className="w-full max-w-xl bg-white rounded-2xl border border-[var(--color-border)] shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-[var(--color-text)]">결제하기</h3>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  데모용 결제창 UI입니다. 실제 PG 결제는 연결되지 않습니다.
                </p>
              </div>
              <button
                onClick={closePaymentModal}
                disabled={isConfirming || isPreparingPayment}
                className="w-8 h-8 rounded-lg hover:bg-gray-100 text-[var(--color-text-secondary)] disabled:opacity-40"
                aria-label="결제창 닫기"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
                <div className="flex items-center justify-between text-sm text-[var(--color-text-secondary)]">
                  <span>주문 상품</span>
                  <span>{totalCount}개 / {itemCount}종</span>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-sm font-semibold text-[var(--color-text)]">최종 결제금액</span>
                  <span className="text-2xl font-bold text-[var(--color-primary)]">{formatAmount(totalAmount)}</span>
                </div>
                {unpricedItems.length > 0 && (
                  <p className="mt-2 text-xs text-red-600">
                    가격 미확인 품목 {unpricedItems.length}개는 0원 처리됩니다.
                  </p>
                )}
              </div>

              <div>
                <p className="text-sm font-semibold text-[var(--color-text)] mb-2">결제 수단</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {PAYMENT_METHOD_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setPaymentMethod(option.value)}
                      className={`text-left rounded-xl border px-3 py-2 transition-colors ${
                        paymentMethod === option.value
                          ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]"
                          : "border-[var(--color-border)] hover:bg-gray-50"
                      }`}
                    >
                      <p className="text-sm font-semibold text-[var(--color-text)]">{option.label}</p>
                      <p className="text-xs text-[var(--color-text-secondary)]">{option.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[var(--color-text-secondary)] mb-1">결제자 이름</label>
                  <input
                    value={payerName}
                    onChange={(event) => setPayerName(event.target.value)}
                    placeholder="홍길동"
                    className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/25"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--color-text-secondary)] mb-1">연락처</label>
                  <input
                    value={payerPhone}
                    onChange={(event) => setPayerPhone(event.target.value)}
                    placeholder="010-1234-5678"
                    className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/25"
                  />
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
                <input
                  type="checkbox"
                  checked={isPaymentAgreed}
                  onChange={(event) => setIsPaymentAgreed(event.target.checked)}
                  className="mt-0.5 accent-[var(--color-primary)]"
                />
                <span>결제 진행 및 주문 정보를 확인했으며 환불 정책에 동의합니다.</span>
              </label>
            </div>

            <div className="px-5 py-4 border-t border-[var(--color-border)] bg-white flex gap-2">
              <button
                type="button"
                onClick={closePaymentModal}
                disabled={isConfirming || isPreparingPayment}
                className="flex-1 px-4 py-3 border border-[var(--color-border)] rounded-xl font-semibold text-[var(--color-text)] hover:bg-gray-50 disabled:opacity-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handlePaymentSubmit}
                disabled={isConfirming || isPreparingPayment || entries.length === 0}
                className="flex-1 px-4 py-3 rounded-xl font-semibold text-white bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
              >
                {isPreparingPayment || isConfirming
                  ? "결제 처리 중..."
                  : `${formatAmount(totalAmount)} 결제하기`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
