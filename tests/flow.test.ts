import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { findUnansweredConversations, type Deps } from "../src/core/conversation.js";
import { DEFAULT_TEXTS } from "../src/core/texts.js";
import { openDatabase, type Database } from "../src/db/client.js";
import {
  agentRuns,
  conversations,
  customers,
  defaultTenantSettings,
  handoffs,
  knowledgeDocs,
  media,
  messages,
  notifications,
  tenants,
  whatsappAccounts,
  type TenantSettings,
} from "../src/db/schema.js";
import type { Llm } from "../src/agents/runner.js";
import { encryptSecret } from "../src/lib/crypto.js";
import type { WhatsAppSender } from "../src/whatsapp/client.js";

const APP_SECRET = "test-secret";
const ZERNIO_SECRET = "zernio-test-secret";
const VERIFY_TOKEN = "verify-me";
const MASTER_KEY = randomBytes(32).toString("base64");
const PHONE_NUMBER_ID = "111222333";
const CUSTOMER = "905321234567";

// Sahte Claude: sistem istemine ve son mesaja göre senaryo oynatır.
let llmMode: "normal" | "throw" | "refusal" | "inject" = "normal";
/** Lina'ya yapılan çağrılar (sistem bağlamını ve geçmişi incelemek için). */
const linaCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];
const systemContextOf = (p: Anthropic.MessageCreateParamsNonStreaming) =>
  (p.system as Anthropic.TextBlockParam[])[1]?.text ?? "";

const fakeLlm: Llm = {
  async create(params) {
    if (llmMode === "throw") throw new Error("API erişilemiyor");
    const system = (params.system as Anthropic.TextBlockParam[])[0]!.text;
    if (system.includes("bilgi uzmanısın")) return reply("Kargo 2-3 iş gününde teslim edilir.");
    linaCalls.push(structuredClone(params));
    if (llmMode === "refusal") return reply("", "refusal");
    if (llmMode === "inject") {
      // Lina cevabı hazırlarken müşteri bir mesaj daha yazdı (cevap hazırlanırken gelen mesaj).
      llmMode = "normal";
      const [conv] = await database.db.select().from(conversations);
      await database.db.insert(messages).values({ tenantId: conv!.tenantId, conversationId: conv!.id, sender: "customer", text: "iki" });
    }

    const last = params.messages.at(-1)!;
    const blocks = last.content as Anthropic.ContentBlockParam[];
    if (blocks[0]?.type === "tool_result") {
      return reply(`Lina: ${String((blocks[0] as Anthropic.ToolResultBlockParam).content)}`);
    }
    if (blocks.some((b) => b.type === "image")) return reply("Fotoğrafınızı gördüm.");
    const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    if (text.includes("kargo")) return toolUse("ask_store_info_agent", { question: "Kargo ne kadar sürer?" });
    if (text.includes("iade")) return toolUse("handoff_to_human", { reason: "return_or_cancel", summary: "İade istiyor" });
    if (text.includes("şikayet")) return toolUse("handoff_to_human", { reason: "complaint", summary: "Ürün hasarlı" });
    return reply("Merhaba, nasıl yardımcı olabilirim?");
  },
};

function message(content: Anthropic.ContentBlock[], stop_reason: Anthropic.StopReason): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
const reply = (text: string, stop: Anthropic.StopReason = "end_turn") =>
  message(text ? [{ type: "text", text, citations: null } as Anthropic.TextBlock] : [], stop);
const toolUse = (name: string, input: unknown) =>
  message([{ type: "tool_use", id: `toolu_${name}`, name, input } as Anthropic.ToolUseBlock], "tool_use");

const sent: { to: string; text: string; token: string }[] = [];
/** Zernio hatlarında cevabın hangi konuşma kimliğiyle gittiği. */
const chatRefs: (string | undefined)[] = [];
/** Her gelen mesaj için "yazıyor…" gösterildi mi (okundu her durumda gider). */
const typing: boolean[] = [];
const fakeWa: WhatsAppSender = {
  async sendText({ to, text, accessToken, chatRef }) {
    sent.push({ to, text, token: accessToken });
    chatRefs.push(chatRef);
    return [`wamid.out.${sent.length}`];
  },
  async markReadAndTyping(opts) {
    typing.push(opts.typing !== false);
  },
  async downloadMedia({ mediaId }) {
    if (mediaId === "broken") throw new Error("indirilemedi");
    return { data: Buffer.from(`jpeg-bytes-${mediaId}`), mimeType: "image/jpeg" };
  },
};

// Varsayılan test saati: Cuma 2026-09-25 12:00 İstanbul (mesai içi).
let now = new Date("2026-09-25T09:00:00Z");

let database: Database;
let server: Server;
let baseUrl: string;
let queue: ReturnType<typeof createApp>["queue"];
let scheduler: ReturnType<typeof createApp>["scheduler"];
let tenantId: string;
let appDeps: Deps;
let msgSeq = 0;

beforeAll(async () => {
  database = await openDatabase({}); // bellekte PGlite
  const deps: Deps = {
    db: database.db,
    llm: fakeLlm,
    wa: fakeWa,
    model: "claude-sonnet-5",
    masterKey: MASTER_KEY,
    historyLimit: 20,
    timeZone: "Europe/Istanbul",
    log: { info() {}, warn() {}, error() {} },
    now: () => now,
    // Bu testler tek tek mesajları dener: beklemeden cevap (art arda mesajlar ayrı testte).
    replyDelayOverrideMs: 0,
  };
  appDeps = deps;
  const created = createApp({ WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN, ZERNIO_WEBHOOK_SECRET: ZERNIO_SECRET }, deps);
  queue = created.queue;
  scheduler = created.scheduler;
  server = created.app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const [tenant] = await database.db
    .insert(tenants)
    .values({ slug: "maius", name: "MAIUS", domain: "maiusonline.com" })
    .returning();
  tenantId = tenant!.id;
  await database.db.insert(knowledgeDocs).values({
    tenantId,
    source: "policy",
    externalId: "SHIPPING_POLICY",
    title: "Kargo",
    content: "Kargo 2-3 iş günü.",
    kind: "core",
    autoEnabled: true,
  });
  await database.db.insert(whatsappAccounts).values({
    tenantId,
    phoneNumberId: PHONE_NUMBER_ID,
    accessTokenEnc: encryptSecret("EAAG-maius", MASTER_KEY),
  });
  await database.db.insert(whatsappAccounts).values({
    tenantId,
    phoneNumberId: "zernio:acc1",
    accessTokenEnc: encryptSecret("sk_zernio", MASTER_KEY),
  });
});

afterAll(async () => {
  server.close();
  await database.close();
});

const MAIUS_SETTINGS: TenantSettings = {
  ...defaultTenantSettings,
  businessHours: { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "17:00" },
};

async function setSettings(patch: Partial<TenantSettings>) {
  await database.db
    .update(tenants)
    .set({ settings: { ...MAIUS_SETTINGS, ...patch } })
    .where(eq(tenants.id, tenantId));
}

beforeEach(async () => {
  sent.length = 0;
  chatRefs.length = 0;
  typing.length = 0;
  linaCalls.length = 0;
  llmMode = "normal";
  now = new Date("2026-09-25T09:00:00Z");
  // Her test temiz bir müşteriyle başlasın.
  await database.db.delete(customers);
  await setSettings({});
});

function payload(msg: Record<string, unknown>, phoneNumberId = PHONE_NUMBER_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: CUSTOMER, profile: { name: "Ayşe" } }],
              messages: [{ from: CUSTOMER, id: `wamid.in.${++msgSeq}`, timestamp: "0", ...msg }],
            },
          },
        ],
      },
    ],
  };
}

async function post(body: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
  await queue.idle();
  await scheduler.idle();
  return res.status;
}

const text = (body: string) => payload({ type: "text", text: { body } });

describe("webhook doğrulama", () => {
  it("doğru token ile challenge döner", async () => {
    const res = await fetch(`${baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`);
    expect(await res.text()).toBe("42");
  });
  it("yanlış token 403", async () => {
    const res = await fetch(`${baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42`);
    expect(res.status).toBe(403);
  });
  it("yanlış imza 401 ve işlem yok", async () => {
    expect(await post(text("merhaba"), "wrong")).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it("WhatsApp ayarları girilmemişse webhook kapalı (503), sunucu çalışır", async () => {
    const { app } = createApp({}, { log: { info() {}, warn() {}, error() {} } } as unknown as Deps);
    const off = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(off.address() as AddressInfo).port}`;
      expect((await fetch(`${url}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1`)).status).toBe(503);
      expect((await fetch(`${url}/webhook/whatsapp`, { method: "POST", body: "{}" })).status).toBe(503);
      expect((await fetch(`${url}/health`)).status).toBe(200);
    } finally {
      off.close();
    }
  });
});

describe("Zernio webhook'u", () => {
  let zSeq = 0;
  const zernioBody = (over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
    id: `evt-${++zSeq}`,
    event: "message.received",
    account: { accountId: "acc1" },
    conversation: { id: "conv-1" },
    message: { id: `zmsg-${zSeq}`, text: "merhaba", platform: "whatsapp", sender: { id: CUSTOMER, name: "Ayşe" }, timestamp: "2026-09-25T09:00:00Z", ...message },
    ...over,
  });
  async function postZernio(body: unknown, secret = ZERNIO_SECRET) {
    const raw = JSON.stringify(body);
    const sig = createHmac("sha256", secret).update(raw).digest("hex");
    const res = await fetch(`${baseUrl}/webhook/zernio`, { method: "POST", headers: { "content-type": "application/json", "x-zernio-signature": sig }, body: raw });
    await queue.idle();
    await scheduler.idle();
    return res.status;
  }

  it("imzalı mesaj cevaplanır: cevap Zernio anahtarı ve konuşma kimliğiyle gider, kimlik saklanır", async () => {
    expect(await postZernio(zernioBody())).toBe(200);
    expect(sent).toEqual([{ to: CUSTOMER, text: "Merhaba, ben Lina. Nasıl yardımcı olabilirim?", token: "sk_zernio" }]);
    expect(chatRefs).toEqual(["conv-1"]);
    const [customer] = await database.db.select().from(customers);
    expect(customer).toMatchObject({ waId: CUSTOMER, name: "Ayşe", channelRef: "conv-1" });
  });

  it("yanlış imza 401, işlem yok", async () => {
    expect(await postZernio(zernioBody(), "yanlis")).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("aynı olay iki kez gelirse tek cevap verilir", async () => {
    const body = zernioBody();
    await postZernio(body);
    await postZernio(body);
    expect(sent).toHaveLength(1);
  });

  it("WhatsApp dışı platform ve başka olaylar sessizce geçilir", async () => {
    expect(await postZernio(zernioBody({}, { platform: "instagram" }))).toBe(200);
    expect(await postZernio(zernioBody({ event: "message.delivered" }))).toBe(200);
    expect(sent).toHaveLength(0);
    expect(await database.db.select().from(messages)).toHaveLength(0);
  });

  it("sır girilmemişse kapalı (503)", async () => {
    const { app } = createApp({ WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "y" }, { log: { info() {}, warn() {}, error() {} } } as unknown as Deps);
    const off = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(off.address() as AddressInfo).port}`;
      expect((await fetch(`${url}/webhook/zernio`, { method: "POST", body: "{}" })).status).toBe(503);
    } finally {
      off.close();
    }
  });
});

describe("mesaj akışı", () => {
  it("Lina SSS uzmanına danışıp cevap verir, kullanım kaydedilir", async () => {
    await database.db.delete(agentRuns);
    expect(await post(text("kargo ne zaman gelir?"))).toBe(200);

    expect(sent).toEqual([{ to: CUSTOMER, text: "Lina: Kargo 2-3 iş gününde teslim edilir.", token: "EAAG-maius" }]);
    const runs = await database.db.select().from(agentRuns);
    expect(runs.map((r) => r.agent).sort()).toEqual(["knowledge", "lina"]);
    expect(runs.find((r) => r.agent === "lina")!.apiCalls).toBe(2);

    const stored = await database.db.select().from(messages).orderBy(messages.createdAt);
    expect(stored.map((m) => m.sender)).toEqual(["customer", "bot"]);
    expect(stored[1]!.waMessageId).toBe("wamid.out.1");
  });

  it("aynı webhook tekrar gelirse ikinci kez cevaplamaz", async () => {
    const body = text("merhaba");
    await post(body);
    await post(body);
    expect(sent).toHaveLength(1);
  });

  it("ilk mesajda tanıtım ister, sonrakinde istemez", async () => {
    await post(text("merhaba"));
    await post(text("nasılsınız"));
    expect(systemContextOf(linaCalls[0]!)).toContain("İlk temas");
    expect(systemContextOf(linaCalls[0]!)).toContain('Cevabın İLK CÜMLESİ her zaman "Merhaba, ben Lina." olsun');
    expect(systemContextOf(linaCalls[1]!)).toContain("kendini yeniden tanıtma");
  });
});

describe("mesai", () => {
  it("mesai içinde 'en kısa sürede' der", async () => {
    await post(text("merhaba"));
    expect(systemContextOf(linaCalls[0]!)).toContain("Ekip şu an çalışıyor");
  });

  it("cuma akşamı yarın (cumartesi) 10:00 der", async () => {
    now = new Date("2026-09-25T16:00:00Z"); // Cuma 19:00
    await post(text("merhaba"));
    expect(systemContextOf(linaCalls[0]!)).toContain("yarın saat 10:00'dan itibaren");
  });

  it("cumartesi akşamı pazartesi 10:00 der", async () => {
    now = new Date("2026-09-26T16:00:00Z"); // Cumartesi 19:00
    await post(text("merhaba"));
    expect(systemContextOf(linaCalls[0]!)).toContain("pazartesi saat 10:00'dan itibaren");
  });
});

describe("devir", () => {
  it("iade talebinde devreder; kuyrukta beklerken basit sorulara cevap vermeye devam eder", async () => {
    await post(text("iade etmek istiyorum"));
    const [conv] = await database.db.select().from(conversations);
    expect(conv!.status).toBe("waiting");
    const [h] = await database.db.select().from(handoffs).where(eq(handoffs.conversationId, conv!.id));
    expect(h).toMatchObject({ reason: "return_or_cancel", summary: "İade istiyor", status: "open" });

    await post(text("merhaba?"));
    expect(sent).toHaveLength(2);
    // Lina bekleyen talepten haberdar.
    expect(systemContextOf(linaCalls.at(-1)!)).toContain("Ekipte bekleyen talep var (return_or_cancel): İade istiyor");
  });

  it("bekleyen talep varken yeni devir mevcut kayda eklenir", async () => {
    await post(text("iade etmek istiyorum"));
    await post(text("bir de şikayetim var"));
    const rows = await database.db.select().from(handoffs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe("İade istiyor\n\n[Ek talep – complaint] Ürün hasarlı");
  });

  it("ekip devraldıysa Lina tamamen susar", async () => {
    await post(text("merhaba"));
    await database.db.update(conversations).set({ status: "human" });
    await post(text("orada mısınız?"));
    expect(sent).toHaveLength(1);
    // Lina cevap vermeyecekse "yazıyor…" gösterilmez; müşteri boşa beklemesin.
    expect(typing).toEqual([true, false]);
    const stored = await database.db.select().from(messages).where(eq(messages.sender, "customer"));
    expect(stored).toHaveLength(2);
  });

  it("Claude hata verirse özür diler ve devreder", async () => {
    llmMode = "throw";
    await post(text("merhaba"));
    expect(sent.map((s) => s.text)).toEqual([DEFAULT_TEXTS.failure]);
    const [conv] = await database.db.select().from(conversations);
    expect(conv!.status).toBe("waiting");
  });

  it("model reddederse özür diler ve devreder", async () => {
    llmMode = "refusal";
    await post(text("merhaba"));
    expect(sent.map((s) => s.text)).toEqual([DEFAULT_TEXTS.failure]);
  });
});

describe("fotoğraf", () => {
  it("fotoğrafı saklar ve Lina'ya görsel olarak gönderir", async () => {
    await post(payload({ type: "image", image: { id: "img1", mime_type: "image/jpeg", caption: "kırık geldi" } }));
    expect(sent.map((s) => s.text)).toEqual(["Merhaba, ben Lina. Fotoğrafınızı gördüm."]);

    const [saved] = await database.db.select().from(media).where(eq(media.waMediaId, "img1"));
    expect(saved!.data.toString()).toBe("jpeg-bytes-img1");

    const blocks = linaCalls[0]!.messages.at(-1)!.content as Anthropic.ContentBlockParam[];
    expect(blocks[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
    expect(blocks[1]).toEqual({ type: "text", text: "[fotoğraf] kırık geldi" });
  });

  it("fotoğraf indirilemezse Lina'ya not olarak geçer", async () => {
    await post(payload({ type: "image", image: { id: "broken" } }));
    const blocks = linaCalls[0]!.messages.at(-1)!.content as Anthropic.ContentBlockParam[];
    expect(blocks).toEqual([{ type: "text", text: "[müşteri fotoğraf gönderdi]" }]);
  });

  it("ekip devraldıysa da fotoğraf saklanır", async () => {
    await post(text("merhaba"));
    await database.db.update(conversations).set({ status: "human" });
    await post(payload({ type: "image", image: { id: "img2" } }));
    expect(await database.db.select().from(media).where(eq(media.waMediaId, "img2"))).toHaveLength(1);
  });
});

describe("sabit metinler ve ayarlar", () => {
  it("ses mesajına varsayılan metni gönderir", async () => {
    await post(payload({ type: "audio", audio: { id: "a1" } }));
    expect(sent.map((s) => s.text)).toEqual([DEFAULT_TEXTS.unsupported]);
  });

  it("sesli mesaj yazıya çevrilir ve normal mesaj gibi cevaplanır; ses kaydı saklanmaz", async () => {
    appDeps.transcribe = async (audio) => (audio.data.length ? "Siparişim ne zaman gelir?" : null);
    try {
      await post(payload({ type: "audio", audio: { id: "a5", mime_type: "audio/ogg; codecs=opus", voice: true } }));
      expect(sent.map((s) => s.text)).toEqual(["Merhaba, ben Lina. Nasıl yardımcı olabilirim?"]);
      const [stored] = await database.db.select().from(messages).where(eq(messages.type, "audio"));
      expect(stored).toMatchObject({ sender: "customer", text: "Siparişim ne zaman gelir?" });
      expect(await database.db.select().from(media)).toEqual([]); // ses saklanmadı
      // Lina metnin yazıya çevrildiğini bilir (yanlış duyulmuş olabilir).
      expect(linaCalls[0]!.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "[sesli mesaj, yazıya çevrildi] Siparişim ne zaman gelir?" }] },
      ]);
    } finally { delete appDeps.transcribe; }
  });

  it("çeviri başarısız ya da boşsa müşteriye 'yazarak iletin' denir; hata cevabı bozmaz", async () => {
    appDeps.transcribe = async () => { throw new Error("servis kapalı"); };
    try {
      await post(payload({ type: "audio", audio: { id: "a6" } }));
      expect(sent.map((s) => s.text)).toEqual([DEFAULT_TEXTS.unsupported]);
    } finally { delete appDeps.transcribe; }
    sent.length = 0;
    appDeps.transcribe = async () => null; // sessiz kayıt
    try {
      await post(payload({ type: "audio", audio: { id: "a7" } }));
      expect(sent.map((s) => s.text)).toEqual([DEFAULT_TEXTS.unsupported]);
    } finally { delete appDeps.transcribe; }
  });

  it("mağazanın kendi metnini kullanır", async () => {
    await setSettings({ texts: { unsupported: "Sesli mesaj dinleyemiyorum, yazar mısınız?" } });
    await post(payload({ type: "audio", audio: { id: "a2" } }));
    expect(sent.map((s) => s.text)).toEqual(["Sesli mesaj dinleyemiyorum, yazar mısınız?"]);
  });

  it("emoji tepkisine ve sistem bildirimine cevap vermez ama kaydeder", async () => {
    await post(payload({ type: "reaction", reaction: { message_id: "wamid.out.1", emoji: "👍" } }));
    await post(payload({ type: "system", system: { body: "Müşteri numarasını değiştirdi" } }));
    await post(payload({ type: "sticker", sticker: { id: "st1", mime_type: "image/webp" } }));
    expect(sent).toHaveLength(0);
    const stored = await database.db.select().from(messages).where(eq(messages.sender, "customer"));
    expect(stored.map((m) => m.type).sort()).toEqual(["reaction", "sticker", "system"]);
  });

  it("tepkiler günlük sınıra sayılmaz ve Lina'nın geçmişine girmez", async () => {
    await setSettings({ dailyMessageLimit: 1 });
    await post(payload({ type: "reaction", reaction: { message_id: "x", emoji: "❤️" } }));
    await post(text("merhaba"));
    expect(sent.map((s) => s.text)).toEqual(["Merhaba, ben Lina. Nasıl yardımcı olabilirim?"]);
    expect(linaCalls[0]!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "merhaba" }] }]);
  });

  it("tanımsız numaraya gelen mesajı yok sayar", async () => {
    await post(payload({ type: "text", text: { body: "selam" } }, "999"));
    expect(sent).toHaveLength(0);
  });

  it("günlük limit aşılınca müşteriye bir şey yazmaz, susar; ekibe bir kez önemli bildirim düşer", async () => {
    await setSettings({ dailyMessageLimit: 1 });
    await post(text("bir"));
    await post(text("iki"));
    await post(text("üç"));
    expect(sent.map((s) => s.text)).toEqual(["Merhaba, ben Lina. Nasıl yardımcı olabilirim?"]);
    expect(typing).toEqual([true, false, false]);
    const notified = await database.db.select().from(notifications);
    expect(notified).toMatchObject([{ kind: "daily_limit", important: true, status: "open", question: "iki", answer: "" }]);
    expect(notified[0]!.details.issues).toEqual([
      "Müşteri bugün 1 mesajı aştı. Lina bugün bu müşteriye yeni cevap hazırlamıyor; müşteriye bilgi verilmedi. Yarın kendiliğinden devam eder.",
    ]);
  });

  it("günlük sınır konuşma ekipteyken aşıldıysa bildirim, Lina'ya geri verildikten sonraki ilk mesajda düşer", async () => {
    await setSettings({ dailyMessageLimit: 1 });
    await post(text("bir"));
    await database.db.update(conversations).set({ status: "human" });
    await post(text("iki"));
    await post(text("üç"));
    expect(await database.db.select().from(notifications)).toEqual([]);
    await database.db.update(conversations).set({ status: "bot" });
    await post(text("dört"));
    expect(await database.db.select().from(notifications)).toMatchObject([{ kind: "daily_limit", question: "dört" }]);
  });

  it("dünkü sınır bildirimi hâlâ açıksa bugün için yenisi açılır; aynı gün ikincisi açılmaz", async () => {
    await setSettings({ dailyMessageLimit: 1 });
    await post(text("bir"));
    await post(text("iki"));
    const [first] = await database.db.select().from(notifications);
    // Bildirim dün açılmış gibi: bugün sınır yine aşılınca ekip yeniden haberdar olmalı.
    await database.db.update(notifications).set({ createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) }).where(eq(notifications.id, first!.id));
    await post(text("üç"));
    await post(text("dört"));
    const rows = await database.db.select().from(notifications);
    expect(rows.map((n) => n.question).sort()).toEqual(["iki", "üç"]);
  });

  it("cevap hazırlanırken gelen mesaj, cevap kaydedildikten sonra bile cevapsız sayılır ve bir sonraki cevaba girer", async () => {
    llmMode = "inject";
    await post(text("bir"));
    expect(sent.map((s) => s.text)).toEqual(["Merhaba, ben Lina. Nasıl yardımcı olabilirim?"]);
    // "iki" ilk cevaptan önce kaydedildi ama o cevap onu görmedi: sonraki cevap ikisini birlikte karşılar.
    await post(text("üç"));
    const lastUser = linaCalls.at(-1)!.messages.at(-1)!.content as Anthropic.ContentBlockParam[];
    expect(lastUser).toEqual([{ type: "text", text: "iki\nüç" }]);
    expect(sent).toHaveLength(2);
    // Cevaplanan mesajlar bir daha cevap beklemez.
    const { respond } = await import("../src/core/conversation.js");
    const [conv] = await database.db.select().from(conversations);
    const again = await respond(appDeps, conv!.id, { signal: new AbortController().signal, isCurrent: () => true });
    expect(again).toBe("nothing");
  });

  it("'yalnızca mesai saatlerinde': mesai dışında Lina susar, 'yazıyor…' yok; mesai açılınca bekleyen mesajı cevaplar", async () => {
    // Test saati cuma 12:00 (İstanbul). Mesai 13:00-18:00: şu an kapalı.
    const hours = (start: string) => ({ days: [0, 1, 2, 3, 4, 5, 6], start, end: "18:00" });
    await setSettings({ botHoursOnly: true, businessHours: hours("13:00") });
    await post(text("siparişim nerede"));
    expect(sent).toEqual([]);
    expect(typing).toEqual([false]);
    const stored = await database.db.select().from(messages).where(eq(messages.sender, "customer"));
    expect(stored).toHaveLength(1); // mesaj kaydedildi, panelde görünür

    // Mesai başladı: aynı mesaj cevaplanır (açılış işi cevapsız konuşmayı sıraya alır).
    await setSettings({ botHoursOnly: true, businessHours: hours("10:00") });
    const { respond, findUnansweredConversations } = await import("../src/core/conversation.js");
    const waiting = await findUnansweredConversations(database.db, new Date(now.getTime() - 72 * 3600_000), tenantId);
    expect(waiting).toHaveLength(1);
    expect(await respond(appDeps, waiting[0]!, { signal: new AbortController().signal, isCurrent: () => true })).toBe("replied");
    expect(sent).toHaveLength(1);
    // Kapalıyken "mesai dışı" ayarı yoksa her saat cevap verilir (varsayılan).
    await setSettings({ businessHours: hours("13:00") });
    await post(text("merhaba"));
    expect(sent).toHaveLength(2);
  });

  it("bot kapalıysa cevap vermez", async () => {
    await setSettings({ botEnabled: false });
    await post(text("merhaba"));
    expect(sent).toHaveLength(0);
  });

  it("eski kayıtlardaki eksik ayarları varsayılanla tamamlar", async () => {
    await database.db.update(tenants).set({ settings: { botEnabled: true } }).where(eq(tenants.id, tenantId));
    await post(text("merhaba"));
    expect(sent).toHaveLength(1);
  });
});

describe("art arda mesajlar (gerçek zamanlayıcı)", () => {
  // Ayrı bir sunucu: bekleme gerçekten devrede (testte 1 dk yerine 0,8 sn).
  const DELAY_MS = 800;
  let app2: ReturnType<typeof createApp>;
  let server2: Server;
  let base2: string;
  const calls2: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let holdNext = false;
  let aborted2 = 0;

  // Sahte Claude: "holdNext" ise iptal edilene kadar bekler (Lina cevabı hazırlıyor).
  const llm2: Llm = {
    async create(params, opts) {
      const system = (params.system as Anthropic.TextBlockParam[])[0]!.text;
      if (system.includes("bilgi uzmanısın")) return reply("bilgi");
      calls2.push(structuredClone(params));
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((_, reject) =>
          opts?.signal?.addEventListener("abort", () => {
            aborted2++;
            reject(new Error("aborted"));
          }),
        );
      }
      const blocks = params.messages.at(-1)!.content as Anthropic.ContentBlockParam[];
      return reply(`Cevap: ${blocks.map((b) => (b.type === "text" ? b.text : "")).join("|")}`);
    },
  };

  beforeAll(() => {
    app2 = createApp({ WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN }, {
      db: database.db,
      llm: llm2,
      wa: fakeWa,
      model: "claude-sonnet-5",
      masterKey: MASTER_KEY,
      historyLimit: 20,
      timeZone: "Europe/Istanbul",
      log: { info() {}, warn() {}, error() {} },
      now: () => now,
      replyDelayOverrideMs: DELAY_MS,
    });
    server2 = app2.app.listen(0);
    base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    app2.scheduler.stop();
    server2.close();
  });
  beforeEach(() => {
    calls2.length = 0;
    aborted2 = 0;
    holdNext = false;
  });

  /** Mesajı gönderir, sadece alınmasını bekler (cevap zamanlayıcıda). */
  async function post2(body: unknown) {
    const raw = JSON.stringify(body);
    const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
    await fetch(`${base2}/webhook/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      body: raw,
    });
    await app2.queue.idle();
  }
  const lastUserContent = (i: number) => calls2[i]!.messages.at(-1)!.content;

  it("'Merhaba / siparişim gelmedi / #1045' → tek Claude çağrısı, tek cevap, tek yazı", async () => {
    await post2(text("Merhaba"));
    await post2(text("siparişim gelmedi"));
    await post2(text("#1045"));
    await app2.scheduler.idle();

    expect(calls2).toHaveLength(1);
    expect(lastUserContent(0)).toEqual([{ type: "text", text: "Merhaba\nsiparişim gelmedi\n#1045" }]);
    expect(sent.map((s) => s.text)).toEqual(["Merhaba, ben Lina. Cevap: Merhaba\nsiparişim gelmedi\n#1045"]);
  });

  it("Lina cevabı hazırlarken gelen mesaj: hazırlanan iptal, hepsine tek cevap; özür ve devir yok", async () => {
    holdNext = true;
    await post2(text("birinci"));
    await vi.waitFor(() => expect(calls2).toHaveLength(1), { timeout: 5_000 }); // Lina hazırlıyor
    await post2(text("ikinci"));
    await app2.scheduler.idle();

    expect(aborted2).toBe(1);
    expect(calls2).toHaveLength(2);
    expect(lastUserContent(1)).toEqual([{ type: "text", text: "birinci\nikinci" }]);
    expect(sent.map((s) => s.text)).toEqual(["Cevap: birinci\nikinci"]);
    expect(await database.db.select().from(handoffs)).toHaveLength(0);
    const runs = await database.db.select().from(agentRuns);
    expect(runs.some((r) => r.agent === "lina" && r.error === "cancelled")).toBe(true);
  });

  it("bekleme sırasında ekip devralırsa Lina hiç cevap vermez", async () => {
    await post2(text("merhaba"));
    await database.db.update(conversations).set({ status: "human" });
    await app2.scheduler.idle();
    expect(calls2).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("sadece sesli mesajlar: sabit metin bir kez; yazıyla karışıksa Lina cevaplar", async () => {
    await post2(payload({ type: "audio", audio: { id: "a1" } }));
    await post2(payload({ type: "audio", audio: { id: "a2" } }));
    await app2.scheduler.idle();
    expect(calls2).toHaveLength(0);
    expect(sent.map((s) => s.text)).toEqual([DEFAULT_TEXTS.unsupported]);

    sent.length = 0;
    await post2(text("fiyatı ne"));
    await post2(payload({ type: "audio", audio: { id: "a3" } }));
    await app2.scheduler.idle();
    expect(calls2).toHaveLength(1);
    expect(lastUserContent(0)).toEqual([{ type: "text", text: "fiyatı ne\n[müşteri sesli mesaj gönderdi]" }]);
    expect(sent).toHaveLength(1);
  });

  it("sunucu bekleme sırasında kapanırsa cevapsız konuşma açılışta bulunur (ekipteyse bulunmaz)", async () => {
    await post2(text("cevapsız kalacak"));
    app2.scheduler.stop(); // sunucu kapandı gibi
    const since = new Date(Date.now() - 60_000);
    const [conv] = await database.db.select().from(conversations);
    expect(await findUnansweredConversations(database.db, since)).toEqual([conv!.id]);

    await database.db.update(conversations).set({ status: "human" });
    expect(await findUnansweredConversations(database.db, since)).toEqual([]);
  });
});
