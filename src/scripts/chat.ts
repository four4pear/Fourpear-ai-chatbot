/**
 * Lina ile terminalden konuşma simülatörü: gerçek Claude + gerçek kurallar, WhatsApp yerine terminal.
 * Veritabanı bellekte açılır, her çalıştırmada temiz başlar.
 *
 *   npm run chat                       (maius mağazası)
 *   npm run chat -- --slug baska-magaza
 *   npm run chat -- --bekleme 5        (art arda mesaj beklemesi: mağaza ayarı yerine 5 sn)
 *   npm run chat -- --demo-siparis     (Shopify bağlı değilken deneme siparişleriyle sipariş uzmanı)
 *
 * Art arda yazılan satırlar hemen alınır; Lina müşteri susunca hepsine tek cevap verir
 * (docs/lina-davranis.md "Art arda mesajlar").
 *
 * Mağaza ve Shopify'dan senkronlanmış bilgileri gerçek veritabanından okur, bellekteki
 * bir kopyada çalışır: test konuşmaları gerçek kayıtlara karışmaz.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import path from "node:path";
import { clearLine, cursorTo } from "node:readline";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { desc, eq, gt, and } from "drizzle-orm";
import { ingestInbound, respond, type Deps, type RespondOutcome } from "../core/conversation.js";
import { ReplyScheduler } from "../core/reply-scheduler.js";
import { exitIfLocked, openDatabase } from "../db/client.js";
import {
  agentRuns,
  conversations,
  customers,
  handoffs,
  knowledgeDocs,
  notifications,
  resolveSettings,
  tenants,
  textArchive,
  whatsappAccounts,
} from "../db/schema.js";
import { isEnabled } from "../knowledge/base.js";
import { llmFromClient } from "../agents/runner.js";
import { encryptSecret } from "../lib/crypto.js";
import { DEMO_ORDERS_HELP, demoOrderSource, demoReturnsProvider } from "../orders/demo.js";
import { NOTIFICATION_LABELS } from "../panel/notifications.js";
import type { WhatsAppSender } from "../whatsapp/client.js";

const { values: args } = parseArgs({
  options: {
    slug: { type: "string", default: "maius" },
    model: { type: "string" },
    bekleme: { type: "string" },
    "demo-siparis": { type: "boolean" },
  },
});

// Claude Sonnet 5 fiyatları ($ / 1M token): girdi 2, çıktı 10; önbellek okuma 0.1x, yazma 1.25x.
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY bulunamadı. Proje klasöründe .env dosyasına şu satırı ekleyin:\n  ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const config = loadConfig();
const source = await openDatabase({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR }).catch(exitIfLocked);
const [realTenant] = await source.db.select().from(tenants).where(eq(tenants.slug, args.slug!));
if (!realTenant) {
  console.log(`'${args.slug}' mağazası bulunamadı. Önce: npm run tenant -- upsert --slug ${args.slug} --name ...`);
  process.exit(1);
}
const realDocs = await source.db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, realTenant.id));
// Kampanya arşivi: sipariş uzmanı ürünlerin sipariş tarihindeki yazısını buradan okur.
const realArchive = await source.db.select().from(textArchive).where(eq(textArchive.tenantId, realTenant.id));
await source.close();

const masterKey = randomBytes(32).toString("base64");
const { db, close } = await openDatabase({});
const [tenant] = await db.insert(tenants).values(realTenant).returning();
if (realDocs.length) await db.insert(knowledgeDocs).values(realDocs);
for (let i = 0; i < realArchive.length; i += 500) await db.insert(textArchive).values(realArchive.slice(i, i + 500));
await db.insert(whatsappAccounts).values({
  tenantId: tenant!.id,
  phoneNumberId: "sim",
  accessTokenEnc: encryptSecret("sim", masterKey),
});

const wa: WhatsAppSender = {
  async sendText({ text }) {
    say(`\n${c.green(c.bold("Lina:"))} ${text}\n`);
    return [`sim.${Date.now()}`];
  },
  async markReadAndTyping() {},
  // Simülatörde "medya kimliği" yerel dosya yoludur.
  async downloadMedia({ mediaId }) {
    const ext = path.extname(mediaId).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return { data: readFileSync(mediaId), mimeType };
  },
};

let simulatedNow: Date | null = null;
const deps: Deps = {
  db,
  llm: llmFromClient(new Anthropic()),
  wa,
  model: args.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
  masterKey,
  historyLimit: 20,
  timeZone: "Europe/Istanbul",
  log: {
    info() {},
    warn: (msg: string) => console.log(c.yellow(`  uyarı: ${msg}`)),
    error: (msg: string, err?: unknown) =>
      console.log(c.yellow(`  hata: ${msg}: ${err instanceof Error ? err.message : String(err ?? "")}`)),
  },
  now: () => simulatedNow ?? new Date(),
  replyDelayOverrideMs: args.bekleme ? Number(args.bekleme) * 1000 : undefined,
  // Deneme siparişleri o an konuşan simülatör müşterisine aittir.
  orderSourceFor: args["demo-siparis"] ? async () => demoOrderSource(() => String(customerNo), () => simulatedNow ?? new Date()) : undefined,
  returnsFor: args["demo-siparis"] ? async () => demoReturnsProvider(() => simulatedNow ?? new Date()) : undefined,
};
const delaySeconds = deps.replyDelayOverrideMs !== undefined ? deps.replyDelayOverrideMs / 1000 : null;

let customerNo = 905300000001;
let seq = 0;
let showAgents = true;
let totalCost = 0;

/** Müşteri mesajını alır; cevap, müşteri susunca zamanlayıcıdan gelir. */
async function send(message: Record<string, unknown>) {
  const result = await ingestInbound(deps, {
    phoneNumberId: "sim",
    contactName: "Test Müşteri",
    message: { from: String(customerNo), id: `sim.in.${++seq}`, timestamp: "0", ...message } as never,
  });
  if (result.outcome !== "queued") {
    if (result.outcome === "daily_limit") scheduler.cancel(result.conversationId);
    console.log(c.dim(`  (cevap yok: ${result.outcome})`));
    return;
  }
  const seconds = delaySeconds ?? result.delayMs / 1000;
  const waitingAlready = scheduler.isPending(result.conversationId);
  scheduler.onCustomerMessage(result.conversationId, {
    delayMs: seconds * 1000,
    maxWaitMs: result.maxWaitMs,
    typing: result.typing,
  });
  console.log(
    c.dim(
      waitingAlready
        ? `  (bekleme baştan başladı: ${seconds} sn)`
        : `  (Lina bekliyor: ${seconds} sn içinde yeni mesaj gelmezse hepsine tek cevap verecek)`,
    ),
  );
}

/** Zamanlayıcı cevap hazırladıktan sonra: uzman çağrıları, devir ve maliyet. */
async function report(outcome: RespondOutcome, since: Date) {
  const runs = await db.select().from(agentRuns).where(gt(agentRuns.createdAt, since)).orderBy(agentRuns.createdAt);
  if (showAgents) {
    for (const run of runs.filter((r) => r.agent !== "lina" && r.error !== "cancelled")) {
      say(c.dim(`  ↳ ${run.agent} uzmanına soruldu: ${run.input}`));
      say(c.dim(`    cevap: ${(run.output ?? "").replace(/\n/g, " ").slice(0, 300)}`));
    }
  }
  const cost = runs.reduce(
    (sum, r) =>
      sum +
      (r.inputTokens * PRICE.input +
        r.outputTokens * PRICE.output +
        r.cacheReadTokens * PRICE.cacheRead +
        r.cacheWriteTokens * PRICE.cacheWrite) /
        1e6,
    0,
  );
  totalCost += cost;
  if (outcome === "cancelled") say(c.yellow("  ✕ Hazırlanan cevap iptal edildi (yeni mesaj geldi ya da ekip devraldı)."));
  if (outcome === "handed_off") {
    const [h] = await db.select().from(handoffs).orderBy(desc(handoffs.createdAt)).limit(1);
    say(c.yellow(`  ⚑ Ekibe devredildi [${h?.reason}]: ${h?.summary}`));
  }
  for (const n of await db.select().from(notifications).where(gt(notifications.createdAt, since))) {
    const issues = n.details.issues?.length ? ` · ${n.details.issues.join(" · ")}` : "";
    say(
      (n.important ? c.yellow : c.dim)(
        `  ${n.important ? "🔔 Önemli bildirim" : "✎ Kayıt"} [${NOTIFICATION_LABELS[n.kind]}] ${n.orderNames.join(", ") || (n.kind === "unverified" ? "sipariş doğrulanamadı" : "sipariş henüz seçilmedi")}${issues}`,
      ),
    );
  }
  say(c.dim(`  bu cevap ~$${cost.toFixed(4)} · toplam ~$${totalCost.toFixed(4)}`));
}

const scheduler = new ReplyScheduler({
  respond: async (conversationId, ctl) => {
    const since = new Date();
    const outcome = await respond(deps, conversationId, ctl);
    await report(outcome, since);
  },
  log: deps.log,
});

async function currentConversation() {
  const [row] = await db
    .select({ conversation: conversations })
    .from(conversations)
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .where(eq(customers.waId, String(customerNo)));
  return row?.conversation ?? null;
}

const HELP = `Komutlar:
  /foto <dosya> [açıklama]   fotoğraf gönder (ör. /foto ~/Desktop/kirik.jpg kırık geldi)
  /ses                       sesli mesaj gönder (desteklenmeyen tip denemesi)
  /saat 2026-09-26 19:30     saati değiştir (mesai testi) · /saat simdi: gerçek saate dön
  /devral                    ekip devraldı gibi yap (Lina susar)
  /geri                      konuşmayı bota geri ver, açık devirleri kapat
  /durum                     konuşma durumu ve açık devir
  /yeni                      yeni müşteri (ilk temas)
  /ajan                      uzman çağrılarını göster/gizle
  /cik                       çık

Art arda yazabilirsiniz: Lina, son mesajınızdan ${delaySeconds !== null ? `${delaySeconds} sn` : "mağaza ayarındaki süre kadar (varsayılan 30 sn)"} sonra hepsine tek cevap verir.`;

const hours = resolveSettings(tenant!.settings).businessHours;
const active = realDocs.filter(isEnabled);
console.log(
  c.cyan(c.bold(`${tenant!.name} · ${tenant!.botName} simülatörü`)) +
    c.dim(` (model: ${deps.model}, mesai ${hours.days.join(",")} ${hours.start}–${hours.end})`),
);
console.log(
  c.dim(
    `Bilgi kaynakları: ${active.filter((d) => d.kind === "core").length} her soruda, ` +
      `${active.filter((d) => d.kind === "legal").length} gerekince` +
      (tenant!.notes ? ", mağaza notları var" : ""),
  ),
);
if (!active.length && !tenant!.notes) {
  console.log(c.yellow("Uyarı: Bu mağazanın Shopify bilgileri henüz senkronlanmamış; Lina bilgi sorularını ekibe devreder."));
}
if (args["demo-siparis"]) {
  console.log(c.cyan(`Deneme siparişleri (uydurma; ${realArchive.length} arşiv kaydıyla):`));
  for (const line of DEMO_ORDERS_HELP) console.log(c.dim(`  ${line}`));
} else {
  console.log(c.dim("Sipariş uzmanı kapalı (Shopify bağlı değil). Denemek için: npm run chat -- --demo-siparis"));
}
console.log(c.dim(HELP) + "\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });
// Girdi dosyadan/borudan gelirse okuyucu erken kapanır; kalan satırlar yine işlenir.
let inputClosed = false;
rl.on("close", () => (inputClosed = true));
const showPrompt = () => {
  if (inputClosed) return;
  const clock: string = simulatedNow
    ? c.yellow(`[${simulatedNow.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}] `)
    : "";
  rl.setPrompt(`${clock}${c.bold("Siz:")} `);
  rl.prompt();
};

/** Siz yazarken gelen çıktı: satırı temizle, yaz, yazmakta olduğunuzu geri getir. */
function say(text: string) {
  if (inputClosed || !process.stdout.isTTY) {
    console.log(text);
    return;
  }
  clearLine(process.stdout, 0);
  cursorTo(process.stdout, 0);
  console.log(text);
  showPrompt();
  process.stdout.write(rl.line);
}

async function handleLine(line: string): Promise<boolean> {
  if (!line.startsWith("/")) {
    await send({ type: "text", text: { body: line } });
    return true;
  }
  const [cmd, ...rest]: string[] = line.split(" ");
  if (cmd === "/cik") return false;
  if (cmd === "/foto") {
    const file = rest[0]?.replace(/^~/, process.env.HOME ?? "~");
    if (!file) console.log("Kullanım: /foto <dosya> [açıklama]");
    else await send({ type: "image", image: { id: path.resolve(file), caption: rest.slice(1).join(" ") || undefined } });
  } else if (cmd === "/ses") {
    await send({ type: "audio", audio: { id: "sim-audio" } });
  } else if (cmd === "/saat") {
    if (rest[0] === "simdi") simulatedNow = null;
    else {
      const d: Date = new Date(`${rest.join("T")}:00+03:00`);
      if (Number.isNaN(d.getTime())) console.log("Kullanım: /saat 2026-09-26 19:30");
      else simulatedNow = d;
    }
  } else if (cmd === "/devral" || cmd === "/geri") {
    const conv = await currentConversation();
    if (!conv) console.log("Önce bir mesaj yazın.");
    else {
      await db.update(conversations).set({ status: cmd === "/devral" ? "human" : "bot" }).where(eq(conversations.id, conv.id));
      // Panelde olduğu gibi: devralınınca Lina'nın bekleyen cevabı iptal.
      if (cmd === "/devral") scheduler.cancel(conv.id);
      if (cmd === "/geri") {
        await db
          .update(handoffs)
          .set({ status: "resolved", resolvedAt: new Date() })
          .where(and(eq(handoffs.conversationId, conv.id), eq(handoffs.status, "open")));
      }
      console.log(c.dim(cmd === "/devral" ? "  Ekip devraldı; Lina susacak." : "  Konuşma bota döndü."));
    }
  } else if (cmd === "/durum") {
    const conv = await currentConversation();
    const open = conv
      ? await db.select().from(handoffs).where(and(eq(handoffs.conversationId, conv.id), eq(handoffs.status, "open")))
      : [];
    console.log(c.dim(`  durum: ${conv?.status ?? "henüz konuşma yok"}`));
    for (const h of open) console.log(c.dim(`  açık devir [${h.reason}]: ${h.summary}`));
  } else if (cmd === "/yeni") {
    customerNo++;
    console.log(c.dim(`  Yeni müşteri: ${customerNo}`));
  } else if (cmd === "/ajan") {
    showAgents = !showAgents;
    console.log(c.dim(`  Uzman çağrıları ${showAgents ? "gösteriliyor" : "gizlendi"}.`));
  } else console.log(HELP);
  return true;
}

try {
  showPrompt();
  // Satırlar hemen alınır; Lina'nın cevabı bekleme bitince gelir (bu sırada yazmaya devam edebilirsiniz).
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      try {
        if (!(await handleLine(line))) break;
      } catch (err) {
        console.log(c.yellow(`Hata: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    showPrompt();
  }
  // Borudan gelen denemelerde: bekleyen cevaplar bitsin.
  if (inputClosed) await scheduler.idle(10 * 60 * 1000);
} finally {
  scheduler.stop();
  rl.close();
  await close();
}
