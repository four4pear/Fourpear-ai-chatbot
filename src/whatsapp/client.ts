export const WHATSAPP_MAX_TEXT = 4096;

/** WhatsApp'a mesaj gönderme arayüzü; testlerde sahtesi kullanılır. */
export interface WhatsAppSender {
  sendText(opts: { phoneNumberId: string; accessToken: string; to: string; text: string }): Promise<string[]>;
  /** typing: false ise mesaj yalnızca okundu işaretlenir, "yazıyor…" gösterilmez. */
  markReadAndTyping(opts: { phoneNumberId: string; accessToken: string; messageId: string; typing?: boolean }): Promise<void>;
  downloadMedia(opts: { accessToken: string; mediaId: string }): Promise<{ data: Buffer; mimeType: string }>;
}

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`WhatsApp Graph API hatası ${status}: ${body}`);
  }
}

export function createWhatsAppClient(graphApiVersion: string): WhatsAppSender {
  async function post(phoneNumberId: string, accessToken: string, body: unknown) {
    const res = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new GraphApiError(res.status, text);
    return JSON.parse(text) as { messages?: { id: string }[] };
  }

  return {
    async sendText({ phoneNumberId, accessToken, to, text }) {
      const ids: string[] = [];
      for (const part of splitMessage(text)) {
        const res = await post(phoneNumberId, accessToken, {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { body: part, preview_url: true },
        });
        const id = res.messages?.[0]?.id;
        if (id) ids.push(id);
      }
      return ids;
    },

    async markReadAndTyping({ phoneNumberId, accessToken, messageId, typing = true }) {
      await post(phoneNumberId, accessToken, {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        ...(typing ? { typing_indicator: { type: "text" } } : {}),
      });
    },

    // Medya iki adımda iner: önce kimlikten geçici URL alınır, sonra URL token ile indirilir.
    async downloadMedia({ accessToken, mediaId }) {
      const auth = { Authorization: `Bearer ${accessToken}` };
      const metaRes = await fetch(`https://graph.facebook.com/${graphApiVersion}/${mediaId}`, { headers: auth });
      if (!metaRes.ok) throw new GraphApiError(metaRes.status, await metaRes.text());
      const info = (await metaRes.json()) as { url: string; mime_type: string };

      const fileRes = await fetch(info.url, { headers: auth });
      if (!fileRes.ok) throw new GraphApiError(fileRes.status, await fileRes.text());
      return { data: Buffer.from(await fileRes.arrayBuffer()), mimeType: info.mime_type };
    },
  };
}

/** Uzun metni WhatsApp sınırına göre paragraf/satır/kelime sınırından böler. */
export function splitMessage(text: string, max = WHATSAPP_MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 2) cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
