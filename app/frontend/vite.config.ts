import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import path from "path";

// app/certs/ 에 mkcert 인증서가 있으면 HTTPS 활성화, 없으면 HTTP fallback
const certsDir = path.resolve(__dirname, "../certs");
const httpsConfig =
  fs.existsSync(path.join(certsDir, "cert.pem")) &&
  fs.existsSync(path.join(certsDir, "key.pem"))
    ? {
        cert: fs.readFileSync(path.join(certsDir, "cert.pem")),
        key: fs.readFileSync(path.join(certsDir, "key.pem")),
      }
    : undefined;

export default defineConfig({
  // AWS 배포용: base를 '/'로 설정 (GitHub Pages는 별도 브랜치 사용)
  base: '/',

  plugins: [react(), tailwindcss()],
  server: {
    host: true,       // 0.0.0.0 바인딩 — 같은 WiFi 기기에서 로컬 IP로 접속 가능
    port: 5173,
    https: httpsConfig,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 5173,
    host: '0.0.0.0',  // 외부 접속 허용
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
