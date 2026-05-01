import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
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

  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["jangbogo.svg", "apple-touch-icon-180x180.png", "favicon.ico"],
      manifest: {
        name: "장보GO",
        short_name: "장보GO",
        description: "AI 기반 실시간 무인 계산 시스템",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "jangbogo.svg",             sizes: "any",     type: "image/svg+xml" },
          { src: "pwa-64x64.png",            sizes: "64x64",   type: "image/png" },
          { src: "pwa-192x192.png",          sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png",          sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            // API/WebSocket은 항상 네트워크 직접 — 캐시 사용 안 함
            urlPattern: /\/api\//,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
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
