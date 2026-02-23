// Shared API utilities.
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
export const BASE = `${API_BASE}/api`;

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}
