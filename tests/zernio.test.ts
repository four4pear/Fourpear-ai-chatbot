import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRoutingSender } from "../src/whatsapp/routing.js";
import type { WhatsAppSender } from "../src/whatsapp/client.js";
import { createZernioClient, isValidZernioSignature, zernioToInbound, type ZernioWebhookPayload } from "../src/whatsapp/zernio.js";
import { listZernioAccounts, registerZernioWebhook } from "../src/whatsapp/zernio-admin.js";

const base = (message: Record<string, unknown> = {}): ZernioWebhookPayload => ({
  id: "evt-1",
  event: "message.received",
  account: { accountId: "acc1" },
  conversation: { id: "conv-1" },
  message: { id: "m1", text: "merhaba", platform: "whatsapp", sender: { id: "905321234567", name: "Ayşe" }, timestamp: "2026-09-25T09:00:00Z", ...message },
});

describe("imza", () => {
  const body = Buffer.from('{"a":1}');
  const sig = createHmac("sha256", "sır").update(body).digest("hex");
  it("doğru sır ve doğru özet kabul edilir", () => expect(isValidZernioSignature(body, sig, "sır")).toBe(true));
  it("yanlış sır, değişmiş gövde, boş ve bozuk başlık reddedilir", () => {
    expect(isValidZernioSignature(body, sig, "başka")).toBe(false);
    expect(isValidZernioSignature(Buffer.from('{"a":2}'), sig, "sır")).toBe(false);
    expect(isValidZernioSignature(body, undefined, "sır")).toBe(false);
    expect(isValidZernioSignature(body, "zz", "sır")).toBe(false);
  });
});

describe("zernioToInbound", () => {
  it("metin mesajı Meta biçimine çevrilir", () => {
    expect(zernioToInbound(base())).toEqual({
      phoneNumberId: "zernio:acc1",
      message: { from: "905321234567", id: "m1", timestamp: String(Date.parse("2026-09-25T09:00:00Z") / 1000), type: "text", text: { body: "merhaba" } },
      contactName: "Ayşe",
      chatRef: "conv-1",
    });
  });
  it("fotoğraf adresi medya kimliği olur, yazı alt yazıdır", () => {
    const e = zernioToInbound(base({ text: "bu", attachments: [{ type: "image", url: "https://cdn.example/a.jpg", mimeType: "image/jpeg" }] }))!;
    expect(e.message.type).toBe("image");
    expect(e.message.image).toEqual({ id: "https://cdn.example/a.jpg", mime_type: "image/jpeg", caption: "bu" });
  });
  it("ses eki sesli mesaj olur; video ve dosya desteklenmeyen tip olarak geçer", () => {
    expect(zernioToInbound(base({ text: "", attachments: [{ type: "audio", url: "https://cdn.example/a.ogg" }] }))!.message.audio).toMatchObject({ id: "https://cdn.example/a.ogg", voice: true });
    expect(zernioToInbound(base({ attachments: [{ type: "video", url: "https://cdn.example/v.mp4" }] }))!.message.type).toBe("video");
    expect(zernioToInbound(base({ attachments: [{ type: "file", url: "https://cdn.example/f.pdf" }] }))!.message.type).toBe("document");
  });
  it("başa + konulmuş numara temizlenir", () => {
    expect(zernioToInbound(base({ sender: { id: "+905321234567" } }))!.message.from).toBe("905321234567");
  });
  it("başka olay, başka platform, eksik alan ve telefon olmayan gönderen null döner", () => {
    expect(zernioToInbound({ ...base(), event: "message.delivered" })).toBeNull();
    expect(zernioToInbound(base({ platform: "instagram" }))).toBeNull();
    expect(zernioToInbound({ ...base(), conversation: undefined })).toBeNull();
    expect(zernioToInbound({ ...base(), account: undefined })).toBeNull();
    expect(zernioToInbound(base({ sender: { id: "TR.2641584643029162" } }))).toBeNull();
    expect(zernioToInbound(base({ sender: { id: "ahmet" } }))).toBeNull();
  });
});

describe("Zernio istemcisi", () => {
  function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    });
    return { fn: fn as unknown as typeof fetch, calls };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("cevap, konuşma adresine hesap kimliği ve anahtarla gider", async () => {
    const { fn, calls } = fakeFetch(() => json({ success: true, data: { messageId: "wamid.1" } }, 201));
    const client = createZernioClient({ baseUrl: "https://z.example/api/v1/", fetchImpl: fn });
    const ids = await client.sendText({ phoneNumberId: "zernio:acc1", accessToken: "sk_x", to: "905321234567", text: "Merhaba", chatRef: "conv/1" });
    expect(ids).toEqual(["wamid.1"]);
    expect(calls[0]!.url).toBe("https://z.example/api/v1/inbox/conversations/conv%2F1/messages");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ accountId: "acc1", message: "Merhaba" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk_x");
  });

  it("uzun metin parçalanır; konuşma kimliği yoksa hata verir", async () => {
    const { fn, calls } = fakeFetch(() => json({ data: { messageId: "w" } }, 201));
    const client = createZernioClient({ fetchImpl: fn });
    const long = Array.from({ length: 1200 }, (_, i) => `satır ${i}`).join("\n");
    await client.sendText({ phoneNumberId: "zernio:acc1", accessToken: "k", to: "1", text: long, chatRef: "c" });
    expect(calls.length).toBeGreaterThan(1);
    await expect(client.sendText({ phoneNumberId: "zernio:acc1", accessToken: "k", to: "1", text: "x" })).rejects.toThrow(/konuşma kimliği/);
  });

  it("API hatası fırlatılır", async () => {
    const { fn } = fakeFetch(() => json({ error: "window closed", code: 131047 }, 400));
    const client = createZernioClient({ fetchImpl: fn });
    await expect(client.sendText({ phoneNumberId: "zernio:a", accessToken: "k", to: "1", text: "x", chatRef: "c" })).rejects.toThrow(/131047/);
  });

  it("yazıyor… reddedilirse bir kez uyarılır ve bir daha denenmez; typing:false hiç çağırmaz", async () => {
    const { fn, calls } = fakeFetch(() => json({ error: "not supported" }, 404));
    const warn = vi.fn();
    const client = createZernioClient({ fetchImpl: fn, log: { warn } });
    const o = { phoneNumberId: "zernio:a", accessToken: "k", messageId: "m", chatRef: "c" };
    await client.markReadAndTyping({ ...o, typing: false });
    expect(calls).toHaveLength(0);
    await client.markReadAndTyping(o);
    await client.markReadAndTyping(o);
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("medya indirirken anahtar yalnızca Zernio'nun kendi adresine gönderilir", async () => {
    const { fn, calls } = fakeFetch(() => new Response("bytes", { headers: { "content-type": "image/png; charset=x" } }));
    const client = createZernioClient({ baseUrl: "https://zernio.com/api/v1", fetchImpl: fn });
    const own = await client.downloadMedia({ accessToken: "sk", mediaId: "https://zernio.com/media/1.png" });
    expect(own.mimeType).toBe("image/png");
    await client.downloadMedia({ accessToken: "sk", mediaId: "https://cdn.baska.com/1.png" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("yönlendirme", () => {
  const make = (tag: string): WhatsAppSender & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      sendText: async () => (calls.push(`${tag}:send`), []),
      markReadAndTyping: async () => void calls.push(`${tag}:typing`),
      downloadMedia: async () => (calls.push(`${tag}:media`), { data: Buffer.alloc(0), mimeType: "x" }),
    };
  };
  it("zernio: hatları Zernio'ya, diğerleri Meta'ya gider; adres medya Zernio'ya", async () => {
    const meta = make("meta");
    const zernio = make("zernio");
    const r = createRoutingSender(meta, zernio);
    await r.sendText({ phoneNumberId: "zernio:a", accessToken: "k", to: "1", text: "x" });
    await r.sendText({ phoneNumberId: "123", accessToken: "k", to: "1", text: "x" });
    await r.markReadAndTyping({ phoneNumberId: "zernio:a", accessToken: "k", messageId: "m" });
    await r.downloadMedia({ accessToken: "k", mediaId: "https://x/y.jpg" });
    await r.downloadMedia({ accessToken: "k", mediaId: "1234567" });
    expect(zernio.calls).toEqual(["zernio:send", "zernio:typing", "zernio:media"]);
    expect(meta.calls).toEqual(["meta:send", "meta:media"]);
  });
});

describe("yönetim çağrıları", () => {
  it("hesap listesi farklı yanıt biçimlerini okur", async () => {
    const make = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    const a = await listZernioAccounts("k", { fetchImpl: make({ accounts: [{ _id: "1", platform: "WhatsApp", displayName: "Betül" }, { id: "2", platform: "instagram", username: "x" }] }) });
    expect(a).toEqual([{ id: "1", platform: "whatsapp", name: "Betül" }, { id: "2", platform: "instagram", name: "x" }]);
    expect(await listZernioAccounts("k", { fetchImpl: make([{ accountId: "3", platform: "whatsapp" }]) })).toEqual([{ id: "3", platform: "whatsapp", name: "" }]);
    expect(await listZernioAccounts("k", { fetchImpl: make({}) })).toEqual([]);
  });
  it("webhook kaydı adres, olay ve sırrı gönderir", async () => {
    let sent: { url: string; body: unknown } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response("{}");
    }) as unknown as typeof fetch;
    await registerZernioWebhook("k", { baseUrl: "https://z.example/api/v1", fetchImpl, url: "https://app/webhook/zernio", secret: "s" });
    expect(sent).toEqual({ url: "https://z.example/api/v1/webhooks/settings", body: { name: "Lina", url: "https://app/webhook/zernio", events: ["message.received"], secret: "s" } });
  });
});
