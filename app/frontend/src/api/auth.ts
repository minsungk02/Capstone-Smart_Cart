import { request } from "./base";

export interface User {
  id: number;
  username: string;
  name: string | null;
  role: string;
  is_active: boolean;
}

export interface SignupData {
  username: string;
  password: string;
  name: string;
  role?: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export function signup(data: SignupData): Promise<User> {
  return request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function login(username: string, password: string): Promise<LoginResponse> {
  const formData = new FormData();
  formData.append("username", username);
  formData.append("password", password);
  return request("/auth/login", {
    method: "POST",
    body: formData,
  });
}

export function getMe(token: string): Promise<User> {
  return request("/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
}
