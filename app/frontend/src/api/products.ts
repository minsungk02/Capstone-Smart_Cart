import { request } from "./base";

export interface Product {
  id?: number | null;
  item_no: string;
  name: string;
<<<<<<< HEAD
  price?: number | null;
  barcd?: string | null;
=======
  price?: number;
  barcd?: string;
  picture?: string | null;
>>>>>>> 270f3d488d0898b40970aabc0b73138e0647890c
  embedding_count: number;
  label?: string;
  picture?: string | null;
}

export interface ListProductsResponse {
  products: Product[];
  total_embeddings: number;
  total_count: number;
  has_more: boolean;
}

export interface AddProductPayload {
  itemNo: string;
  name: string;
  price: number;
  barcd?: string;
  images: File[];
}

export interface ProductDetail {
  id: number;
  item_no: string;
  product_name: string;
  barcd: string | null;
  stock: number | null;
  price: number | null;
  available_fields: {
    stock: boolean;
    discount: boolean;
  };
}

export interface UpdateProductDetailPayload {
  product_name?: string;
  barcd?: string | null;
  price?: number;
  stock?: number;
  is_discounted?: boolean;
  discount_rate?: number;
  discount_amount?: number;
}

/**
 * 페이지네이션을 지원하는 상품 목록 조회
 */
export function listProducts(
  token?: string,
  params?: { skip: number; limit: number }
): Promise<ListProductsResponse> {
  const query = params ? `?skip=${params.skip}&limit=${params.limit}` : "";
  return request(`/products${query}`, { token });
}

export function addProduct(payload: AddProductPayload) {
  const form = new FormData();
  form.append("item_no", payload.itemNo);
  form.append("name", payload.name);
  form.append("price", String(payload.price));
  if (payload.barcd?.trim()) {
    form.append("barcd", payload.barcd.trim());
  }
  payload.images.forEach((f) => form.append("images", f));

  return request<{
    status: string;
    item_no: string;
    product_name: string;
    label: string;
    price: number;
    images_count: number;
    total_products: number;
    total_embeddings: number;
  }>("/products", {
    method: "POST",
    body: form,
  });
}

export function deleteProduct(itemNo: string) {
  return request<{ status: string }>(`/products/${itemNo}`, {
    method: "DELETE",
  });
}

export function getProductDetail(itemNo: string): Promise<ProductDetail> {
  return request(`/products/${encodeURIComponent(itemNo)}/detail`);
}

export function updateProductDetail(itemNo: string, payload: UpdateProductDetailPayload) {
  return request<{ status: string; item_no: string }>(`/products/${encodeURIComponent(itemNo)}/detail`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}