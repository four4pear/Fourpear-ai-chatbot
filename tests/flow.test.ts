import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Deps } from "../src/core/conversation.js";
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
  tenants,
  whatsappAccounts,
  type TenantSettings,
} from "../src/db/schema.js";
import type { Llm } from "../src/agents/runner.js";
import { encryptSecret } from "../src/lib/crypto.js";
import type { WhatsAppSender } from "../src/whatsapp/client.js";

const APP_SECRET = "test-secret";
const VERIFY_TOKEN = "verify-me";
const MASTER_KEY = randomBytes(32).toString("base64");
const PHONE_NUMBER_ID = "111222333";
const CUSTOMER = "905321234567";

// Sahte Claude: sistem istemine ve son mesaja göre senaryo oynatır.
let llmMode: "normal" | "throw" | "refusal" = "normal";
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
const fakeWa: WhatsAppSender = {
  async sendText({ to, text, accessToken }) {
    sent.push({ to, text, token: accessToken });
    return [`wamid.out.${sent.length}`];
  },
  async markReadAndTyping() {},
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
let tenantId: string;
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
  };
  const created = createApp({ WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN }, deps);
  queue = created.queue;
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
    expect(systemContextOf(linaCalls[0]!)).toContain("Merhaba, ben Lina, MAIUS'un dijital asistanıyım.");
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
    expect(sent.map((s) => s.text)).toEqual(["Fotoğrafınızı gördüm."]);

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

  it("mağazanın kendi metnini kullanır", async () => {
    await setSettings({ texts: { unsupported: "Sesli mesaj dinleyemiyorum, yazar mısınız?" } });
    await post(payload({ type: "audio", audio: { id: "a2" } }));
    expect(sent.map((s) => s.text)).toEqual(["Sesli mesaj dinleyemiyorum, yazar mısınız?"]);
  });

  it("tanımsız numaraya gelen mesajı yok sayar", async () => {
    await post(payload({ type: "text", text: { body: "selam" } }, "999"));
    expect(sent).toHaveLength(0);
  });

  it("günlük limit aşılınca bir kez uyarır, sonra susar", async () => {
    await setSettings({ dailyMessageLimit: 1 });
    await post(text("bir"));
    await post(text("iki"));
    await post(text("üç"));
    expect(sent.map((s) => s.text)).toEqual(["Merhaba, nasıl yardımcı olabilirim?", DEFAULT_TEXTS.dailyLimit]);
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
