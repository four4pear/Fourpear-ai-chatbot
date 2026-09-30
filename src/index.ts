import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull } from "drizzle-orm";
import { createApp } from "./app.js";
import { loadConfig, whatsappConfigured } from "./config.js";
import { exitIfLocked, openDatabase } from "./db/client.js";
import { resolveSettings, shopifyStores, tenants } from "./db/schema.js";
import { llmFromClient } from "./agents/runner.js";
import { syncAllStores, syncStoreKnowledge } from "./knowledge/sync.js";
import { archiveAllTenants } from "./archive/sync.js";
import { shopifyOrderSource } from "./orders/shopify.js";
import { returnsProviderFor } from "./returns/provider.js";
import { shopifyApps } from "./shopify/apps.js";
import { createShopifyApi } from "./shopify/client.js";
import { createWhatsAppClient } from "./whatsapp/client.js";
import { EventBus } from "./core/events.js";
import { findUnansweredConversations, type Deps } from "./core/conversation.js";

/** Düzenli işler üst üste binmesin: önceki çalışma bitmeden yenisi başlamaz. */
function exclusive(task: () => Promise<unknown>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } finally {
      running = false;
    }
  };
}

const config = (() => {
  try {
    return loadConfig(process.env, { server: true });
  } catch (err) {
    // Eksik ayarları yığın izi olmadan, okunur biçimde göster.
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();
const { db, close } = await openDatabase({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR }).catch(exitIfLocked);

// WhatsApp tarafı ile panel aynı olay kanalını paylaşır (canlı güncelleme).
const events = new EventBus();

const deps: Deps = {
  db,
  events,
  llm: llmFromClient(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })),
  wa: createWhatsAppClient(config.GRAPH_API_VERSION),
  model: config.CLAUDE_MODEL,
  masterKey: config.MASTER_KEY,
  historyLimit: config.HISTORY_LIMIT,
  timeZone: config.TZ,
  log: console,
  // İade sistemi bağlı mağazada Lina iade talebinin durumunu okur (yalnızca okuma).
  returnsFor: (tenantId) => returnsProviderFor(db, config.MASTER_KEY, tenantId),
};

let shopifyRoutes;
let syncTimer: NodeJS.Timeout | undefined;
if (config.APP_URL) {
  // Her mağaza kendi Shopify uygulamasıyla bağlanır; sunucu ayarındaki uygulama ortak yedektir.
  const apps = shopifyApps(
    db,
    config.MASTER_KEY,
    config.SHOPIFY_API_KEY && config.SHOPIFY_API_SECRET
      ? { apiKey: config.SHOPIFY_API_KEY, apiSecret: config.SHOPIFY_API_SECRET }
      : undefined,
  );
  const shopify = createShopifyApi({
    db,
    masterKey: config.MASTER_KEY,
    appFor: apps.forTenant,
    apiVersion: config.SHOPIFY_API_VERSION,
  });
  shopifyRoutes = {
    db,
    shopify,
    apps,
    appUrl: config.APP_URL.replace(/\/$/, ""),
    masterKey: config.MASTER_KEY,
    syncStore: (store: Parameters<typeof syncStoreKnowledge>[2]) => syncStoreKnowledge(db, shopify, store),
    log: console,
  };
  // Uygulaması kurulu mağazada sipariş uzmanı açılır (docs/lina-davranis.md §3).
  deps.orderSourceFor = async (tenantId) => {
    const [row] = await db
      .select({ store: shopifyStores, settings: tenants.settings })
      .from(shopifyStores)
      .innerJoin(tenants, eq(tenants.id, shopifyStores.tenantId))
      .where(and(eq(shopifyStores.tenantId, tenantId), isNull(shopifyStores.uninstalledAt)));
    return row ? shopifyOrderSource(shopify, row.store, { countryCode: resolveSettings(row.settings).phoneCountryCode }) : null;
  };
  // Shopify sayfa/politika değişikliği için bildirim göndermiyor: düzenli kontrol.
  const runSync = exclusive(() => syncAllStores(db, shopify, console).catch((err) => console.error("Bilgi senkronu", err)));
  void runSync();
  syncTimer = setInterval(runSync, config.KNOWLEDGE_SYNC_MINUTES * 60 * 1000);
} else {
  console.warn("APP_URL eksik: Shopify kurulumu ve bilgi senkronu kapalı.");
}

// Kampanya arşivi: ürün ve site yazıları tarihleriyle saklanır (Shopify uygulaması gerekmez).
const runArchive = exclusive(() => archiveAllTenants(db, console).catch((err) => console.error("Arşiv", err)));
void runArchive();
const archiveTimer = setInterval(runArchive, config.ARCHIVE_SYNC_MINUTES * 60 * 1000);

const localUrl = `http://localhost:${config.PORT}`;
const publicUrl = (config.APP_URL ?? localUrl).replace(/\/$/, "");
const panel = {
  db,
  publicUrl,
  // Panel aynı adresten açılır; geliştirmede Vite (5173) de izinli.
  allowedOrigins: [
    new URL(publicUrl).origin,
    localUrl,
    ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173"]),
  ],
  secureCookies: publicUrl.startsWith("https://"),
  log: console,
  wa: deps.wa,
  masterKey: config.MASTER_KEY,
  events,
};

const { app, queue, scheduler } = createApp(config, deps, shopifyRoutes, panel);

// Sunucu bir bekleme sırasında kapandıysa: son 10 dk'da cevapsız kalan müşteriler yeniden sıraya alınır.
const unanswered = await findUnansweredConversations(db, new Date(Date.now() - 10 * 60 * 1000));
for (const conversationId of unanswered) {
  scheduler.onCustomerMessage(conversationId, { delayMs: 5_000, maxWaitMs: 5_000 });
}
if (unanswered.length) console.log(`Cevapsız kalan ${unanswered.length} konuşma yeniden sıraya alındı.`);

const server = app.listen(config.PORT, () => {
  console.log(`Sunucu hazır: http://localhost:${config.PORT} (webhook: /webhook/whatsapp, model: ${config.CLAUDE_MODEL})`);
  if (!whatsappConfigured(config)) {
    console.warn("WhatsApp ayarları (WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN) eksik: WhatsApp webhook'u kapalı, panel çalışır.");
  }
});

async function shutdown() {
  console.log("Kapanıyor, bekleyen mesajlar tamamlanıyor...");
  clearInterval(syncTimer);
  clearInterval(archiveTimer);
  // Bekleyen cevaplar bir sonraki açılışta yeniden kurulur (findUnansweredConversations).
  scheduler.stop();
  server.close();
  await queue.idle();
  await close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
