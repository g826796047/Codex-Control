import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Codex Control",
        short_name: "Codex",
        description: "Secure mobile control for Codex on your PC",
        theme_color: "#111315",
        background_color: "#f4f5f6",
        display: "standalone",
        start_url: "/",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        navigateFallback: "/index.html",
        runtimeCaching: [{
          urlPattern: /\/api\/threads\//,
          handler: "NetworkFirst",
          options: { cacheName: "codex-control-recent", networkTimeoutSeconds: 2, expiration: { maxEntries: 30, maxAgeSeconds: 86_400 } },
        }],
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4689", ws: true, changeOrigin: false },
    },
  },
});

