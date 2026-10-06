#!/usr/bin/env node
/**
 * Canlı sistemin bağlantı sağlığı: sunucu, panel, webhook'lar. Gizli bilgi gerekmez, yalnızca herkese açık
 * adreslere (yanlış kod / imzasız istek) sorar. Kullanım: npm run saglik [-- https://adres]
 */
const base = (process.argv[2] ?? process.env.APP_URL ?? "https://fourpear-ai-chatbot-production.up.railway.app").replace(/\/$/, "");

const checks = [
  { ad: "Sunucu sağlık (/health)", path: "/health", beklenen: 200 },
  { ad: "Panel ana sayfası", path: "/", beklenen: 200 },
  { ad: "Panel API oturumsuz reddediliyor", path: "/api/me", beklenen: 401 },
  { ad: "Meta webhook: yanlış kod reddediliyor", path: "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1", beklenen: 403 },
  { ad: "Meta webhook: imzasız mesaj reddediliyor", path: "/webhook/whatsapp", method: "POST", body: "{}", beklenen: 401 },
  { ad: "Zernio webhook: imzasız mesaj reddediliyor", path: "/webhook/zernio", method: "POST", body: "{}", beklenen: 401 },
  { ad: "Zernio webhook: sahte imza reddediliyor", path: "/webhook/zernio", method: "POST", body: "{}", headers: { "x-zernio-signature": "abc" }, beklenen: 401 },
];

let sorun = 0;
console.log(`Sağlık kontrolü: ${base}\n`);
for (const c of checks) {
  let durum;
  try {
    const res = await fetch(base + c.path, { method: c.method ?? "GET", body: c.body, headers: c.headers, signal: AbortSignal.timeout(15000) });
    durum = res.status;
  } catch (err) {
    durum = `ulaşılamadı (${err.cause?.code ?? err.message})`;
  }
  const tamam = durum === c.beklenen;
  if (!tamam) sorun++;
  const not = tamam ? "" : durum === 503 ? "  → ayar eksik (Railway Variables)" : durum === 404 ? "  → bu adres sunucuda yok (eski sürüm çalışıyor olabilir)" : "";
  console.log(`${tamam ? "✅" : "❌"} ${c.ad}  [${durum}${tamam ? "" : `, beklenen ${c.beklenen}`}]${not}`);
}
try {
  const res = await fetch(base + "/", { signal: AbortSignal.timeout(15000) });
  const csp = res.headers.get("content-security-policy");
  console.log(`${csp ? "✅" : "❌"} Güvenlik başlıkları (CSP, çerçeveleme engeli)`);
  if (!csp) sorun++;
} catch { /* yukarıda raporlandı */ }

console.log(sorun ? `\n${sorun} sorun var.` : "\nHer şey yolunda.");
process.exit(sorun ? 1 : 0);
