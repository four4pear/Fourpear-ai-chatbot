import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express, type Response } from "express";

/** panel/dist: `npm run build` ile üretilen panel dosyaları. */
export const DEFAULT_PANEL_DIST = path.resolve(import.meta.dirname, "../../panel/dist");

/**
 * Panel sayfaları için güvenlik başlıkları:
 * - Başka siteler paneli çerçeve içine alamaz (tıklama kandırmacası).
 * - Sadece kendi dosyalarımız çalışır; dışarıdan betik/stil/yazı tipi yok.
 * - Davet/şifre linkindeki anahtar dış sitelere Referer ile gitmez.
 */
function securityHeaders(res: Response) {
  res.set({
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
}

/** Panelin adresleri; hepsi aynı index.html'i açar, sayfayı tarayıcıdaki yönlendirici seçer. */
const PANEL_ROUTES = ["/", "/giris", "/yonetici", "/davet/:token", "/sifre/:token", "/m/*rest"];

export function registerPanelStatic(app: Express, distDir: string, log: Pick<Console, "warn">) {
  const index = path.join(distDir, "index.html");
  if (!existsSync(index)) {
    log.warn(`Panel derlenmemiş (${index} yok): 'npm run build' çalıştırın. Panel adresleri kapalı.`);
    return;
  }

  // Derlenen dosya adları içerik özetini taşır: uzun süre önbelleğe alınabilir.
  app.use(
    "/assets",
    express.static(path.join(distDir, "assets"), {
      index: false,
      immutable: true,
      maxAge: "365d",
      setHeaders: (res) => res.set("X-Content-Type-Options", "nosniff"),
    }),
  );

  app.get(PANEL_ROUTES, (_req, res) => {
    securityHeaders(res);
    // Sayfa her açılışta güncel sürümü alsın.
    res.set("Cache-Control", "no-store");
    res.sendFile(index);
  });
}
