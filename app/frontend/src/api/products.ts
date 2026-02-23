import { request } from "./base";

export interface Product {
  name: string;
  embedding_count: number;
}

export function listProducts(): Promise<{
  products: Product[];
  total_embeddings: number;
}> {
  return request("/products");
}

export function addProduct(name: string, images: File[]) {
  const form = new FormData();
  form.append("name", name);
  images.forEach((f) => form.append("images", f));
  return request<{ status: string; product_name: string }>("/products", {
    method: "POST",
    body: form,
  });
}
