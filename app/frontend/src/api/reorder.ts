import { request } from "./base";

export interface ReorderSuggestion {
  product_name: string;
  item_no: string | null;
  total_sold: number;
  current_stock: number;      // 이 줄 추가
  suggested_quantity: number;
  unit_price: number | null;
}

export interface ReorderItemPayload {
  product_name: string;
  item_no?: string | null;
  quantity: number;
  unit_price?: number | null;
}

export interface ReorderResponse {
  id: number;
  admin_id: number;
  admin_name: string;
  items: ReorderItemPayload[];
  total_quantity: number;
  total_amount: number;
  status: "pending" | "ordered" | "received" | "cancelled";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function getReorderSuggestions(
  token: string,
  limit = 15,
  sort: "best_seller" | "low_stock" = "best_seller"
): Promise<ReorderSuggestion[]> {
  return request(`/reorder/suggestions?limit=${limit}&sort=${sort}`, { token });
}

export function createReorder(
  token: string,
  payload: { items: ReorderItemPayload[]; notes?: string }
): Promise<ReorderResponse> {
  return request("/reorder", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export function listReorders(token: string): Promise<ReorderResponse[]> {
  return request("/reorder", { token });
}

export function updateReorderStatus(
  token: string,
  reorderId: number,
  status: string
): Promise<ReorderResponse> {
  return request(`/reorder/${reorderId}/status`, {
    method: "PATCH",
    token,
    body: JSON.stringify({ status }),
  });
}

export function deleteReorder(token: string, reorderId: number): Promise<void> {
  return request(`/reorder/${reorderId}`, {
    method: "DELETE",
    token,
  });
}