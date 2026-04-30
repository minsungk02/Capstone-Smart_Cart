import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { Routes, Route, Link, useLocation, Navigate } from "react-router-dom";
import HomePage from "./pages/HomePage";
import CheckoutPage from "./pages/CheckoutPage";
import ProductsPage from "./pages/ProductsPage";
import WishlistPage from "./pages/WishListPage";
import ValidatePage from "./pages/ValidatePage";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import MyPage from "./pages/MyPage";
import AdminPurchasesPage from "./pages/AdminPurchasesPage";
import AllProductsPage from "./pages/AllProductsPage";
import ChatbotWidget from "./components/ChatbotWidget";
import { useAuthStore } from "./stores/authStore";
import { shouldRedirectForAdminRoute } from "./routing/guards";

const USER_NAV_ITEMS = [
  { path: "/", label: "홈", icon: "🏠" },
  { path: "/checkout", label: "장보GO", icon: "jangbogo" },
  { path: "/wishlist", label: "찜목록", icon: "❤️" },
  { path: "/validate", label: "영수증 확인", icon: "📋" },
  { path: "/mypage", label: "마이페이지", icon: "👤" },
];

const ADMIN_NAV_ITEMS = [
  { path: "/", label: "홈", icon: "🏠" },
  { path: "/products", label: "상품 관리", icon: "📦" },
  { path: "/admin/purchases", label: "구매 내역", icon: "📊" },
];

export default function App() {
  const { pathname } = useLocation();
  const isCheckoutPage = pathname === "/checkout";
  const isAuthPage = pathname === "/login" || pathname === "/signup";

  const { user, clearAuth, isAuthenticated, isAdmin } = useAuthStore();
  const isAdminUser = isAdmin();
  const shouldRenderChatbot = true;
  const shouldUseMobileHeaderChatbot = !isCheckoutPage;
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isChatbotOpen, setIsChatbotOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const resetScroll = () => {
      mainRef.current?.scrollTo({ top: 0, left: 0 });
    };
    resetScroll();
  }, [pathname]);

  useEffect(() => {
    const handleClickOutside = (event: PointerEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
        setIsProfileMenuOpen(false);
      }
    };
    if (isProfileMenuOpen) {
      document.addEventListener("pointerdown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("pointerdown", handleClickOutside);
    };
  }, [isProfileMenuOpen]);

  useEffect(() => {
    setIsProfileMenuOpen(false);
    setIsChatbotOpen(false);
  }, [pathname]);

  if (isAuthPage) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
      </Routes>
    );
  }

  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  if (shouldRedirectForAdminRoute(pathname, isAdminUser)) {
    return <Navigate to="/" replace />;
  }

  const NAV_ITEMS = isAdminUser ? ADMIN_NAV_ITEMS : USER_NAV_ITEMS;

  return (
    <div className="h-screen flex flex-col lg:flex-row overflow-hidden bg-[var(--color-bg)]">
      {/* 고정된 사이드바[cite: 3] */}
      <aside className="hidden lg:flex w-64 bg-[var(--color-sidebar)] border-r border-[var(--color-border)] flex-col relative z-[70] shrink-0">
        <div className="p-6 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3">
            <img src="/jangbogo.svg" alt="장보GO 로고" className="w-10 h-10 rounded-xl object-cover" />
            <div>
              <h1 className="text-lg font-bold text-[var(--color-text)]">장보GO</h1>
              <p className="text-xs text-[var(--color-text-secondary)]">JangboGO</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                    : "text-[var(--color-text-secondary)] hover:bg-white hover:text-[var(--color-text)]"
                }`}
              >
                {item.icon === "jangbogo" ? (
                  <img src="/jangbogo.svg" alt="장보GO 아이콘" className="w-5 h-5 rounded object-cover" />
                ) : (
                  <span className="text-lg">{item.icon}</span>
                )}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-[var(--color-border)]">
          <div className="space-y-3">
            <div className="px-4 py-2 bg-gray-50 rounded-lg">
              <p className="text-xs text-gray-500">로그인됨</p>
              <p className="text-sm font-medium">{user?.name}</p>
            </div>
            <button
              onClick={() => clearAuth()}
              className="w-full px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
            >
              로그아웃
            </button>
          </div>
        </div>
      </aside>

      {/* 메인 스크롤 영역[cite: 3] */}
      <main
        ref={mainRef}
        className={`flex-1 overflow-y-auto relative ${isCheckoutPage ? 'pb-0' : 'pb-16 lg:pb-0'}`}
      >
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/wishlist" element={<WishlistPage />} />
          <Route path="/validate" element={<ValidatePage />} />
          <Route path="/mypage" element={<MyPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/admin/purchases" element={<AdminPurchasesPage />} />
          <Route path="/all-products" element={<AllProductsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {shouldRenderChatbot && (
        <ChatbotWidget open={isChatbotOpen} onOpenChange={setIsChatbotOpen} hideMobileTrigger={shouldUseMobileHeaderChatbot} />
      )}
    </div>
  );
}