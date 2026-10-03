import express from "express";
import { whatsappConfigured, type Config } from "./config.js";
import { ingestInbound, respond, type Deps } from "./core/conversation.js";
import { KeyedQueue } from "./core/queue.js";
import { ReplyScheduler } from "./core/reply-scheduler.js";
import { registerShopifyRoutes, type ShopifyRouteDeps } from "./shopify/routes.js";
import { registerPanelApi, type PanelApiDeps } from "./panel/api.js";
import { DEFAULT_PANEL_DIST, registerPanelStatic } from "./panel/static.js";
import { isValidSignature } from "./whatsapp/signature.js";
import { extractInboundEvents, type WaWebhookPayload } from "./whatsapp/types.js";

export function createApp(
  config: Pick<Config, "WHATSAPP_APP_SECRET" | "WHATSAPP_VERIFY_TOKEN">,
  deps: Deps,
  shopify?: ShopifyRouteDeps,
  panel?: PanelApiDeps,
) {
  const app = express();
  // Railway gibi bir vekil sunucunun arkasında gerçek istemci IP'si (giriş deneme sınırı için).
  app.set("trust proxy", 1);
  // Aynı müşterinin mesajları sırayla alınır.
  const queue = new KeyedQueue((err, key) => deps.log.error(`Mesaj işlenemedi (${key})`, err));
  // Art arda mesajlar: müşteri susunca hepsine tek cevap (docs/lina-davranis.md).
  const scheduler = new ReplyScheduler({
    respond: async (conversationId, ctl) => {
      const outcome = await respond(deps, conversationId, ctl);
      deps.log.info(`[${conversationId}] cevap → ${outcome}`);
    },
    refreshTyping: (t) => deps.wa.markReadAndTyping({ ...t.wa, messageId: t.messageId }),
    log: deps.log,
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // WhatsApp ayarları girilene kadar webhook kapalı (imzasız istek asla işlenmez).
  const whatsappOff = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (whatsappConfigured(config)) return next();
    res.status(503).json({ error: "WhatsApp henüz ayarlanmadı (WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN)" });
  };

  // Meta webhook doğrulaması (uygulama panelinde "Verify and save").
  app.get("/webhook/whatsapp", whatsappOff, (req, res) => {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === config.WHATSAPP_VERIFY_TOKEN && typeof challenge === "string") {
      res.type("text/plain").send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  app.post("/webhook/whatsapp", whatsappOff, express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidSignature(raw, req.get("x-hub-signature-256"), config.WHATSAPP_APP_SECRET!)) {
      res.sendStatus(401);
      return;
    }

    let payload: WaWebhookPayload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.sendStatus(400);
      return;
    }

    // Meta hızlı 200 bekler; işleme arka planda devam eder.
    res.sendStatus(200);
    for (const event of extractInboundEvents(payload)) {
      queue.push(`${event.phoneNumberId}:${event.message.from}`, async () => {
        const result = await ingestInbound(deps, event);
        deps.log.info(`[${event.phoneNumberId}] ${event.message.from} ${event.message.type} → ${result.outcome}`);
        if (result.outcome === "queued") {
          scheduler.onCustomerMessage(result.conversationId, {
            delayMs: deps.replyDelayOverrideMs ?? result.delayMs,
            maxWaitMs: result.maxWaitMs,
            typing: result.typing,
          });
        }
        // Günlük sınır aşıldıysa yeni cevap kurulmaz; sınırın içindeki önceki mesajlar için
        // hazırlanan cevap iptal edilmez (müşteri cevapsız kalmasın).
      });
    }
  });

  if (shopify) registerShopifyRoutes(app, shopify);
  if (panel) {
    // Ekip konuşmayı devralınca Lina'nın bekleyen/hazırlanan cevabı iptal edilir.
    registerPanelApi(app, {
      ...panel,
      simulatorDeps: deps,
      cancelPendingReply: (id) => scheduler.cancel(id),
      // Ekibin cevabı geldi: Lina kısa bir beklemeyle (art arda cevaplar birleşsin) müşteriye yazar.
      triggerReply: (id) => scheduler.onCustomerMessage(id, { delayMs: 2_000, maxWaitMs: 2_000 }),
    });
    registerPanelStatic(app, panel.distDir ?? DEFAULT_PANEL_DIST, deps.log);
  }

  return { app, queue, scheduler };
}
