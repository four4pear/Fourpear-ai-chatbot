import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { exitIfLocked, openDatabase } from "./db/client.js";
import { llmFromClient } from "./agents/runner.js";
import { syncAllStores, syncStoreKnowledge } from "./knowledge/sync.js";
import { createShopifyApi } from "./shopify/client.js";
import { createWhatsAppClient } from "./whatsapp/client.js";

const config = loadConfig();
const { db, close } = await openDatabase({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR }).catch(exitIfLocked);

const deps = {
  db,
  llm: llmFromClient(new Anthropic()),
  wa: createWhatsAppClient(config.GRAPH_API_VERSION),
  model: config.CLAUDE_MODEL,
  masterKey: config.MASTER_KEY,
  historyLimit: config.HISTORY_LIMIT,
  timeZone: config.TZ,
  log: console,
};

let shopifyRoutes;
let syncTimer: NodeJS.Timeout | undefined;
if (config.SHOPIFY_API_KEY && config.SHOPIFY_API_SECRET && config.APP_URL) {
  const shopify = createShopifyApi({
    db,
    masterKey: config.MASTER_KEY,
    app: { apiKey: config.SHOPIFY_API_KEY, apiSecret: config.SHOPIFY_API_SECRET },
    apiVersion: config.SHOPIFY_API_VERSION,
  });
  shopifyRoutes = {
    db,
    shopify,
    app: { apiKey: config.SHOPIFY_API_KEY, apiSecret: config.SHOPIFY_API_SECRET },
    appUrl: config.APP_URL.replace(/\/$/, ""),
    masterKey: config.MASTER_KEY,
    syncStore: (store: Parameters<typeof syncStoreKnowledge>[2]) => syncStoreKnowledge(db, shopify, store),
    log: console,
  };
  // Shopify sayfa/politika değişikliği için bildirim göndermiyor: düzenli kontrol.
  const runSync = () => syncAllStores(db, shopify, console).catch((err) => console.error("Bilgi senkronu", err));
  void runSync();
  syncTimer = setInterval(runSync, config.KNOWLEDGE_SYNC_MINUTES * 60 * 1000);
} else {
  console.warn("Shopify ayarları (SHOPIFY_API_KEY, SHOPIFY_API_SECRET, APP_URL) eksik: Shopify kurulumu ve bilgi senkronu kapalı.");
}

const { app, queue } = createApp(config, deps, shopifyRoutes);

const server = app.listen(config.PORT, () => {
  console.log(`Sunucu hazır: http://localhost:${config.PORT} (webhook: /webhook/whatsapp, model: ${config.CLAUDE_MODEL})`);
});

async function shutdown() {
  console.log("Kapanıyor, bekleyen mesajlar tamamlanıyor...");
  clearInterval(syncTimer);
  server.close();
  await queue.idle();
  await close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
