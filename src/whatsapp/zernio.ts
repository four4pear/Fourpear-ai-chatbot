import { createHmac, timingSafeEqual } from "node:crypto";
import { splitMessage, type WhatsAppSender } from "./client.js";
import type { InboundEvent, WaIncomingMessage } from "./types.js";

/**
 * Zernio (zernio.com): WhatsApp'ı Meta'nın resmi yolundan bağlayan aracı servis. Bizim tarafta Zernio
 * hesabı `whatsapp_accounts.phone_number_id` alanında "zernio:<hesap kimliği>" olarak durur; erişim
 * anahtarı olarak mağazanın Zernio API anahtarı saklanır. Cevap göndermek için Zernio'nun konuşma
 * kimliği gerekir; webhook'tan gelir ve müşteri kaydında (customers.channel_ref) saklanır.
 */
export const ZERNIO_PREFIX = "zernio:";
export const DEFAULT_ZERNIO_API = "https://zernio.com/api/v1";

export const isZernioAccount = (phoneNumberId: string) => phoneNumberId.startsWith(ZERNIO_PREFIX);
export const zernioAccountId = (phoneNumberId: string) => phoneNumberId.slice(ZERNIO_PREFIX.length);

export class ZernioApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Zernio API hatası ${status}: ${body}`);
  }
}

/** X-Zernio-Signature: ham gövdenin HMAC-SHA256 özeti (küçük harfli hex), anahtar bizim belirlediğimiz sır. */
export function isValidZernioSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header.trim().replace(/^sha256=/i, ""), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Webhook yükünün kullandığımız kısmı (belge: docs.zernio.com/webhooks).
export type ZernioWebhookPayload = {
  id?: string;
  event?: string;
  account?: { accountId?: string; id?: string };
  conversation?: { id?: string };
  message?: {
    id?: string;
    text?: string;
    platform?: string;
    sender?: { id?: string; name?: string };
    attachments?: { type?: string; url?: string; mimeType?: string; mime_type?: string }[];
    timestamp?: string;
  };
};

const ATTACHMENT_TYPES: Record<string, string> = { image: "image", audio: "audio", voice: "audio", video: "video", file: "document", document: "document" };

/**
 * message.received (WhatsApp) olayını Meta'daki gelen mesaj biçimine çevirir; böylece alma hattı
 * (kaydet, okundu, fotoğraf, sesli mesaj, zamanlayıcı) aynen çalışır. Başka olaylar ve başka
 * platformlar için null döner.
 */
export function zernioToInbound(payload: ZernioWebhookPayload): InboundEvent | null {
  if (payload.event !== "message.received") return null;
  const m = payload.message;
  if (!m || m.platform?.toLowerCase() !== "whatsapp") return null;

  const accountId = payload.account?.accountId ?? payload.account?.id;
  const chatRef = payload.conversation?.id;
  // WhatsApp'ta gönderen kimliği telefon numarasıdır; kullanıcı adı gibi başka bir kimlik gelirse işlenmez.
  const from = m.sender?.id?.trim().replace(/^\+/, "");
  const id = m.id ?? payload.id;
  if (!accountId || !chatRef || !from || !/^\d{6,15}$/.test(from) || !id) return null;

  const attachment = m.attachments?.find((a) => a.url);
  const kind = attachment ? (ATTACHMENT_TYPES[attachment.type?.toLowerCase() ?? ""] ?? "document") : "text";
  const seconds = Math.floor((m.timestamp ? Date.parse(m.timestamp) : Date.now()) / 1000);
  const message: WaIncomingMessage = {
    from,
    id,
    timestamp: String(Number.isFinite(seconds) ? seconds : Math.floor(Date.now() / 1000)),
    type: kind,
  };
  const mimeType = attachment?.mimeType ?? attachment?.mime_type;
  if (kind === "text") message.text = { body: m.text ?? "" };
  else if (kind === "image") message.image = { id: attachment!.url!, mime_type: mimeType, caption: m.text };
  else if (kind === "audio") message.audio = { id: attachment!.url!, mime_type: mimeType, voice: true };
  else message[kind] = { id: attachment!.url!, mime_type: mimeType };

  return { phoneNumberId: ZERNIO_PREFIX + accountId, message, contactName: m.sender?.name, chatRef };
}

/** Zernio üzerinden WhatsApp: cevap gönderme, "yazıyor…" ve gelen medyayı indirme. */
export function createZernioClient(opts: { baseUrl?: string; fetchImpl?: typeof fetch; log?: { warn: (msg: string) => void } } = {}): WhatsAppSender {
  const base = (opts.baseUrl ?? DEFAULT_ZERNIO_API).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  // "Yazıyor…" ucu belgelerde ayrıntılı değil: reddedilirse bir kez haber verip bırakırız.
  let typingBroken = false;

  async function post(path: string, apiKey: string, body: unknown) {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ZernioApiError(res.status, text);
    return text ? (JSON.parse(text) as { data?: { messageId?: string } }) : {};
  }

  return {
    async sendText({ phoneNumberId, accessToken, text, chatRef }) {
      if (!chatRef) throw new Error("Zernio konuşma kimliği yok: müşteri henüz bu hat üzerinden yazmamış");
      const ids: string[] = [];
      for (const part of splitMessage(text)) {
        const res = await post(`/inbox/conversations/${encodeURIComponent(chatRef)}/messages`, accessToken, {
          accountId: zernioAccountId(phoneNumberId),
          message: part,
        });
        if (res.data?.messageId) ids.push(res.data.messageId);
      }
      return ids;
    },

    async markReadAndTyping({ phoneNumberId, accessToken, messageId, typing = true, chatRef }) {
      if (!typing || typingBroken || !chatRef) return;
      try {
        await post("/messages/send-typing-indicator", accessToken, {
          accountId: zernioAccountId(phoneNumberId),
          conversationId: chatRef,
          messageId,
        });
      } catch (err) {
        if (err instanceof ZernioApiError && err.status >= 400 && err.status < 500) {
          typingBroken = true;
          opts.log?.warn(`Zernio "yazıyor…" göstergesi reddedildi, bir daha denenmeyecek: ${err.message}`);
        } else throw err;
      }
    },

    // Zernio ekleri adresle verir (mediaId = adres). Anahtarı yalnızca Zernio'nun kendi adresine yollarız.
    async downloadMedia({ accessToken, mediaId }) {
      const url = new URL(mediaId);
      const ownHost = new URL(base).hostname;
      const headers: Record<string, string> = url.hostname === ownHost || url.hostname.endsWith(`.${ownHost}`) ? { Authorization: `Bearer ${accessToken}` } : {};
      const res = await doFetch(url, { headers });
      if (!res.ok) throw new ZernioApiError(res.status, await res.text());
      return { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream" };
    },
  };
}
