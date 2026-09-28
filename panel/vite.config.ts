import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Geliştirme: `npm run dev` (sunucu, 3000) + `npm run dev:panel` (bu, 5173).
// Canlı: `npm run build` panel/dist'i üretir, sunucu aynı adresten verir.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  // Dosyalar sayfaya gömülmez (data: adresi olmaz): güvenlik kuralı (CSP) "sadece kendi dosyalarımız" kalabilsin.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
});
