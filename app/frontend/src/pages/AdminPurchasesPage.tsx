import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import { getAllPurchases } from "../api/purchases";
import PurchasesTable from "../components/admin/PurchasesTable";

export default function AdminPurchasesPage() {
  const { token, isAdmin } = useAuthStore();
  const isAdminUser = isAdmin();

  const { data: purchases = [], isLoading } = useQuery({
    queryKey: ["purchases", "all"],
    queryFn: () => getAllPurchases(token!),
    enabled: isAdminUser && !!token,
  });

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-[28px] font-extrabold tracking-tight text-[var(--color-text)] flex items-center gap-2">
          <span>📋</span>전체 구매 내역
        </h1>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1">
          모든 사용자의 구매 내역을 검색·정렬하고 CSV로 내보낼 수 있습니다.
        </p>
      </div>

      <PurchasesTable items={purchases} isLoading={isLoading} />
    </div>
  );
}
