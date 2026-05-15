import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import {
  getDiscountCategories,
  getDiscountProducts,
  getPopularProducts,
} from "../api/purchases";

const formatDiscountAmount = (value: number) =>
  `₩${Math.max(0, value ?? 0).toLocaleString("ko-KR")}`;

function formatDiscountRate(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${safe.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
}

export default function HomePage() {
  const { token } = useAuthStore();
  const [failedPopularImages, setFailedPopularImages] = useState<Record<string, true>>({});
  const [selectedDiscountCategory, setSelectedDiscountCategory] = useState("");
  const [failedDiscountImages, setFailedDiscountImages] = useState<Record<string, true>>({});

  const { data: userPopularProducts = [] } = useQuery({
    queryKey: ["popular-products", "user-popup", token],
    queryFn: () => getPopularProducts(token!, 5),
    enabled: !!token,
  });

  const { data: discountCategories = [], isLoading: isDiscountCategoriesLoading } = useQuery({
    queryKey: ["discount-categories", "user-home", token],
    queryFn: () => getDiscountCategories(token!),
    enabled: !!token,
  });

  const activeDiscountCategory = discountCategories.includes(selectedDiscountCategory)
    ? selectedDiscountCategory
    : discountCategories[0] ?? "";

  const { data: discountProducts = [], isLoading: isDiscountProductsLoading } = useQuery({
    queryKey: ["discount-products", "user-home", token, activeDiscountCategory],
    queryFn: () => getDiscountProducts(token!, activeDiscountCategory, 5),
    enabled: !!token && activeDiscountCategory.length > 0,
  });

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-6xl mx-auto space-y-4 md:space-y-6 lg:space-y-8">
      {/* Real-time Best */}
      <div className="bg-white rounded-2xl p-6 border border-[var(--color-border)] shadow-sm">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-2xl font-bold text-[var(--color-text)] mb-1">
              실시간 베스트
            </h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              지금 가장 많이 담긴 인기 상품 TOP 5
            </p>
          </div>
          <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-orange-50 text-orange-700 text-xs font-semibold">
            LIVE TOP5
          </span>
        </div>

        {userPopularProducts.length > 0 ? (
          <div className="flex gap-1.5 sm:gap-2.5 overflow-x-auto pb-1 snap-x snap-mandatory">
            {userPopularProducts.map((product, index) => {
              const pictureKey = `${product.name}:${product.picture ?? ""}`;
              const hasPicture = Boolean(product.picture) && !failedPopularImages[pictureKey];
              return (
                <div
                  key={product.name}
                  className="min-w-[100px] sm:min-w-[126px] max-w-[147px] shrink-0 snap-start rounded-xl border border-[var(--color-border)] bg-white p-2.5 sm:p-3.5"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="inline-flex w-6 h-6 items-center justify-center rounded-full bg-orange-100 text-orange-700 text-[11px] font-bold">
                      {index + 1}
                    </span>
                    <span className="text-xs font-semibold text-[var(--color-primary)]">
                      {product.total_count}개
                    </span>
                  </div>
                  {hasPicture ? (
                    <img
                      src={product.picture || ""}
                      alt={`${product.name} 상품 이미지`}
                      className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl object-contain bg-white p-1 mb-2.5 border border-[var(--color-border)]"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setFailedPopularImages((prev) =>
                          prev[pictureKey] ? prev : { ...prev, [pictureKey]: true }
                        )
                      }
                    />
                  ) : (
                    <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl bg-[var(--color-primary-light)] text-[var(--color-primary)] flex items-center justify-center text-base font-bold mb-2.5">
                      {(product.name || "?").slice(0, 1)}
                    </div>
                  )}
                  <p className="text-[13px] sm:text-sm leading-tight font-semibold text-[var(--color-text)] break-words line-clamp-2 min-h-[2.2rem]">
                    {product.name}
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="h-24 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
            아직 인기 상품 집계 데이터가 없습니다.
          </div>
        )}
      </div>

      {/* Discount Top5 by Category */}
      <div className="bg-white rounded-2xl p-6 border border-[var(--color-border)] shadow-sm">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-2xl font-bold text-[var(--color-text)] mb-1">
              카테고리별 할인 상품
            </h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              선택한 카테고리에서 할인율이 높은 상품 TOP 5
            </p>
          </div>
          {activeDiscountCategory ? (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-red-50 text-red-700 text-xs font-semibold">
              {activeDiscountCategory}
            </span>
          ) : null}
        </div>

        {isDiscountCategoriesLoading ? (
          <div className="h-16 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
            카테고리 로딩 중...
          </div>
        ) : discountCategories.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {discountCategories.map((category) => (
              <label
                key={category}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm cursor-pointer transition-colors ${
                  activeDiscountCategory === category
                    ? "bg-orange-50 border-orange-300 text-orange-700"
                    : "bg-white border-[var(--color-border)] text-[var(--color-text)] hover:bg-gray-50"
                }`}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-orange-500"
                  checked={activeDiscountCategory === category}
                  onChange={() => setSelectedDiscountCategory(category)}
                />
                <span>{category}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="h-16 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
            표시할 카테고리가 없습니다.
          </div>
        )}

        <div className="mt-4">
          {activeDiscountCategory && isDiscountProductsLoading ? (
            <div className="h-28 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
              할인 상품 로딩 중...
            </div>
          ) : discountProducts.length > 0 ? (
            <div className="space-y-3">
              {discountProducts.map((product, index) => {
                const pictureKey = `${product.item_no}:${product.picture ?? ""}`;
                const hasPicture =
                  Boolean(product.picture) && !failedDiscountImages[pictureKey];
                return (
                  <div
                    key={`${activeDiscountCategory}-${product.item_no}-${index}`}
                    className="rounded-xl border border-[var(--color-border)] p-3 bg-white"
                  >
                    <div className="flex items-center gap-3">
                      <span className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-red-100 text-red-700 text-xs font-bold">
                        {index + 1}
                      </span>
                      {hasPicture ? (
                        <img
                          src={product.picture || ""}
                          alt={`${product.product_name} 상품 이미지`}
                          className="w-11 h-11 rounded-lg object-cover border border-[var(--color-border)]"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={() =>
                            setFailedDiscountImages((prev) =>
                              prev[pictureKey]
                                ? prev
                                : { ...prev, [pictureKey]: true }
                            )
                          }
                        />
                      ) : (
                        <div className="w-11 h-11 rounded-lg bg-red-50 text-red-600 flex items-center justify-center text-sm font-bold">
                          {(product.product_name || "?").slice(0, 1)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-[var(--color-text)] break-words">
                          {product.product_name}
                        </p>
                        <p className="text-xs text-[var(--color-text-secondary)]">
                          상품코드: {product.item_no}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-red-700">
                          {formatDiscountRate(product.discount_rate)}
                        </p>
                        <p className="text-xs text-[var(--color-text-secondary)]">
                          할인금액 {formatDiscountAmount(product.discount_amount)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : activeDiscountCategory ? (
            <div className="h-24 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
              {activeDiscountCategory} 카테고리의 할인 상품이 없습니다.
            </div>
          ) : (
            <div className="h-24 rounded-xl border border-dashed border-[var(--color-border)] flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
              카테고리를 선택해 주세요.
            </div>
          )}
        </div>
      </div>

      {/* CTA Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Checkout Card */}
        <div className="bg-white rounded-2xl p-8 border border-[var(--color-border)] shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-14 h-14 rounded-2xl bg-[var(--color-primary-light)] flex items-center justify-center flex-shrink-0">
              <img
                src="/jangbogo.svg"
                alt="장보GO 아이콘"
                className="w-10 h-10 rounded-xl object-cover"
              />
            </div>
            <div className="flex-1">
              <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">
                장보GO
              </h3>
              <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                카메라에 상품을 보여주면 장바구니에 자동으로 담겨요.
                담긴 상품을 확인한 뒤 바로 결제할 수 있어요.
              </p>
            </div>
          </div>
          <Link
            to="/checkout"
            className="block w-full py-3 px-6 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium rounded-xl text-center transition-colors"
          >
            장보GO 시작
          </Link>
        </div>

        {/* Validate Card */}
        <div className="bg-white rounded-2xl p-8 border border-[var(--color-border)] shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-14 h-14 rounded-2xl bg-[var(--color-secondary-light)] flex items-center justify-center flex-shrink-0">
              <span className="text-3xl">📋</span>
            </div>
            <div className="flex-1">
              <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">
                영수증 확인
              </h3>
              <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                체크아웃한 상품 목록을 확인하고 수정할 수 있습니다. 최종
                결제 전에 상품을 검토하고 조정하세요.
              </p>
            </div>
          </div>
          <Link
            to="/validate"
            className="block w-full py-3 px-6 bg-white hover:bg-gray-50 text-[var(--color-text)] font-medium rounded-xl text-center border border-[var(--color-border)] transition-colors"
          >
            영수증 확인
          </Link>
        </div>
      </div>

      {/* Key Features */}
      <div>
        <h3 className="text-lg font-bold text-[var(--color-text)] mb-4">
          주요 기능
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Feature 1 */}
          <div className="bg-white rounded-xl p-6 border border-[var(--color-border)] text-center">
            <div className="w-12 h-12 rounded-full bg-[var(--color-success-light)] flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-6 h-6 text-[var(--color-success)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <h4 className="font-semibold text-[var(--color-text)] mb-2">
              실시간 인식
            </h4>
            <p className="text-sm text-[var(--color-text-secondary)]">
              AI 기반 실시간 상품 인식으로 빠르고 정확한 체크아웃
            </p>
          </div>

          {/* Feature 2 */}
          <div className="bg-white rounded-xl p-6 border border-[var(--color-border)] text-center">
            <div className="w-12 h-12 rounded-full bg-[var(--color-primary-light)] flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">🛒</span>
            </div>
            <h4 className="font-semibold text-[var(--color-text)] mb-2">
              자동 장바구니
            </h4>
            <p className="text-sm text-[var(--color-text-secondary)]">
              인식된 상품이 자동으로 장바구니에 추가
            </p>
          </div>

          {/* Feature 3 */}
          <div className="bg-white rounded-xl p-6 border border-[var(--color-border)] text-center">
            <div className="w-12 h-12 rounded-full bg-[var(--color-secondary-light)] flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-6 h-6 text-[var(--color-secondary)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
            </div>
            <h4 className="font-semibold text-[var(--color-text)] mb-2">
              간편한 검증
            </h4>
            <p className="text-sm text-[var(--color-text-secondary)]">
              영수증 확인 페이지에서 쉽게 검토 및 수정
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
