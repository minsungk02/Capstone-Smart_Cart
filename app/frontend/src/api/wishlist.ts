import { request } from "./base";

export interface WishlistItem {
  id: number;
  item_no: string;
  product_name: string;
  price?: number; // 총 합산을 위해 가격 필드가 필요합니다.
  created_at: string;
}

export function getWishlist(token: string): Promise<WishlistItem[]> {
  return request("/wishlist", { token });
}

export function addToWishlist(token: string, itemNo: string, name: string) {
  return request("/wishlist", {
    method: "POST",
    token,
    body: JSON.stringify({ item_no: itemNo, product_name: name }),
  });
}

export function removeFromWishlist(token: string, id: number) {
  return request(`/wishlist/${id}`, {
    method: "DELETE",
    token,
  });
}