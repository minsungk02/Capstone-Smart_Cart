import { request } from "./base";

export interface PurchaseItem {
  name: string;
  count: number;
  unit_price?: number | null;
  line_total?: number | null;
}

export interface PurchaseResponse {
  id: number;
  user_id: number;
  username: string;
  items: PurchaseItem[];
  total_amount: number;
  timestamp: string;
  notes?: string | null;
}

export interface PopularProduct {
  item_no: string; // 상품 번호를 명시적으로 저장[cite: 8]
  name: string;
  total_count: number;
  picture?: string | null;
}

export interface DiscountProduct {
  item_no: string;
  product_name: string;
  discount_rate: number;
  discount_amount: number;
  picture?: string | null;
}

export interface DashboardStats {
  total_purchases: number;
  total_customers: number;
  today_purchases: number;
  total_products_sold: number;
  popular_products: PopularProduct[];
  recent_purchases: PurchaseResponse[];
  daily_stats: Array<{ date: string; purchase_count: number; revenue: number }>;
  total_revenue: number;
  average_order_value: number;
  today_revenue: number;
}

/**
 * 레이블(예: 10091_꼬깔콘)에서 번호와 이름을 분리하는 헬퍼 함수
 */
function splitLabel(combinedName: string): { item_no: string; name: string } {
  if (combinedName.includes("_")) {
    const parts = combinedName.split("_");
    const potentialId = parts[0];
    if (/^\d+$/.test(potentialId)) { // 앞부분이 숫자인 경우에만 ID로 간주
      return {
        item_no: potentialId,
        name: parts.slice(1).join("_")
      };
    }
  }
  return { item_no: combinedName, name: combinedName };
}

export function getMyPurchases(token: string): Promise<PurchaseResponse[]> {
  return request("/purchases/my", { token });
}

export function getAllPurchases(token: string): Promise<PurchaseResponse[]> {
  return request("/purchases/all", { token });
}

export function createPurchase(
  token: string,
  payload: { session_id: string; items: Array<{ name: string; count: number }>; notes?: string }
): Promise<PurchaseResponse> {
  return request("/purchases", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export function deletePurchase(token: string, purchaseId: number) {
  return request(`/purchases/${purchaseId}`, {
    method: "DELETE",
    token,
  });
}

export async function getDashboardStats(token: string, periodDays?: number): Promise<DashboardStats> {
  const query = periodDays ? `?period_days=${periodDays}` : "";
  const data = await request<DashboardStats>(`/purchases/dashboard${query}`, { token });
  return {
    ...data,
    daily_stats: data.daily_stats ?? [],
    total_revenue: data.total_revenue ?? 0,
    average_order_value: data.average_order_value ?? 0,
    today_revenue: data.today_revenue ?? 0,
  };
}

/**
 * 실시간 베스트 상품을 가져오면서 번호/이름 분리 로직 적용
 */
export async function getPopularProducts(token: string, limit = 5): Promise<PopularProduct[]> {
  const rows = await request<PopularProduct[]>(`/purchases/popular?limit=${limit}`, { token });
  return (rows ?? []).map((row) => {
    const { item_no, name } = splitLabel(row.name);
    return {
      ...row,
      item_no: row.item_no || item_no, // 원래 번호가 있으면 쓰고, 없으면 이름에서 추출[cite: 8]
      name: name,
      picture: row.picture ?? null,
    };
  });
}

export async function getDiscountCategories(token: string): Promise<string[]> {
  const rows = await request<string[]>("/purchases/discount-categories", { token });
  return (rows ?? [])
    .map((category) => String(category ?? "").trim())
    .filter((category) => category.length > 0);
}

export async function getDiscountProducts(
  token: string,
  categoryL: string,
  limit = 5
): Promise<DiscountProduct[]> {
  const query = `?category_l=${encodeURIComponent(categoryL)}&limit=${limit}`;
  const rows = await request<DiscountProduct[]>(`/purchases/discounts${query}`, { token });
  return (rows ?? []).map((row) => ({
    ...row,
    item_no: String(row.item_no ?? ""),
    product_name: String(row.product_name ?? ""),
    discount_rate: Number(row.discount_rate ?? 0),
    discount_amount: Number(row.discount_amount ?? 0),
    picture: row.picture ?? null,
  }));
}