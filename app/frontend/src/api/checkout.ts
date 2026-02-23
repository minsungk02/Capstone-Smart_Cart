import { BASE, request } from "./base";

export interface SessionResponse {
  session_id: string;
}

export interface ROIResponse {
  points: number[][] | null;
  num_vertices: number;
}

export interface BillingState {
  billing_items: Record<string, number>;
  item_scores: Record<string, number>;
  total_count: number;
  item_unit_prices: Record<string, number | null>;
  item_line_totals: Record<string, number>;
  total_amount: number;
  currency: string;
  unpriced_items: string[];
}

export function createSession(): Promise<SessionResponse> {
  return request("/sessions", { method: "POST" });
}

export function deleteSession(id: string): Promise<void> {
  return request(`/sessions/${id}`, { method: "DELETE" });
}

export function setROI(
  sessionId: string,
  points: number[][],
): Promise<ROIResponse> {
  return request(`/sessions/${sessionId}/roi`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
  });
}

export function clearROI(sessionId: string): Promise<void> {
  return request(`/sessions/${sessionId}/roi`, { method: "DELETE" });
}

export function getBilling(sessionId: string): Promise<BillingState> {
  return request(`/sessions/${sessionId}/billing`);
}

export function updateBilling(
  sessionId: string,
  billing_items: Record<string, number>,
): Promise<BillingState> {
  return request(`/sessions/${sessionId}/billing`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ billing_items }),
  });
}

export function confirmBilling(sessionId: string) {
  return request<{
    status: string;
    confirmed_items: Record<string, number>;
    confirmed_total: number;
    confirmed_total_amount: number;
    currency: string;
    unpriced_items: string[];
  }>(
    `/sessions/${sessionId}/billing/confirm`,
    { method: "POST" },
  );
}

export function uploadVideo(
  sessionId: string,
  file: File,
): Promise<{ task_id: string }> {
  const form = new FormData();
  form.append("file", file);
  return request(`/sessions/${sessionId}/video-upload`, {
    method: "POST",
    body: form,
  });
}

export function getHealth(): Promise<Record<string, unknown>> {
  return request("/health");
}

export function wsCheckoutUrl(sessionId: string): string {
  const backendUrl = import.meta.env.VITE_API_BASE_URL || location.origin;
  const wsBase = backendUrl.replace(/^http/, "ws");
  return `${wsBase}/api/ws/checkout/${sessionId}`;
}

export function videoStatusUrl(sessionId: string, taskId: string): string {
  return `${BASE}/sessions/${sessionId}/video-status?task_id=${taskId}`;
}
