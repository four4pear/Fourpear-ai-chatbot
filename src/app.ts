import express from "express";
import type { Config } from "./config.js";
import { handleInbound, type Deps } from "./core/conversation.js";
import { KeyedQueue } from "./core/queue.js";
import { registerShopifyRoutes, type ShopifyRouteDeps } from "./shopify/routes.js";
import { isValidSignature } from "./whatsapp/signature.js";
import { extractInboundEvents, type WaWebhookPayload } from "./whatsapp/types.js";

export function createApp(
  config: Pick<Config, "WHATSAPP_APP_SECRET" | "WHATSAPP_VERIFY_TOKEN">,
  deps: Deps,
  shopify?: ShopifyRouteDeps,
) {
  const app = express();
  // Aynı müşterinin mesajları sırayla işlenir.
  const queue = new KeyedQueue((err, key) => deps.log.error(`Mesaj işlenemedi (${key})`, err));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Meta webhook doğrulaması (uygulama panelinde "Verify and save").
  app.get("/webhook/whatsapp", (req, res) => {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === config.WHATSAPP_VERIFY_TOKEN && typeof challenge === "string") {
      res.type("text/plain").send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  app.post("/webhook/whatsapp", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidSignature(raw, req.get("x-hub-signature-256"), config.WHATSAPP_APP_SECRET)) {
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
        const outcome = await handleInbound(deps, event);
        deps.log.info(`[${event.phoneNumberId}] ${event.message.from} ${event.message.type} → ${outcome}`);
      });
    }
  });

  if (shopify) registerShopifyRoutes(app, shopify);

  return { app, queue };
}
