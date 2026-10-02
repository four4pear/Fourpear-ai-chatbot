import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { openDatabase, type DB } from "../db/client.js";
import {
  agentRuns,
  conversations,
  customerMemories,
  customers,
  handoffs,
  knowledgeDocs,
  lessons,
  messages,
  teamQuestions,
  tenants,
  textArchive,
  whatsappAccounts,
} from "../db/schema.js";
import { TEAM_ANSWER_TYPE, teamAnswerText } from "../core/team-questions.js";
import { updateMemory } from "../core/memory.js";
import { ingestInbound, respond, type Deps } from "../core/conversation.js";
import { encryptSecret } from "../lib/crypto.js";
import { demoOrderSource, demoReturnsProvider, DEMO_ORDERS_HELP } from "../orders/demo.js";

/** team: ekibin "Lina soruyor" cevabı (test ekranında ekip yerine siz cevaplarsınız). */
type Turn = { role: "user" | "assistant" | "team"; text: string; question?: string };

/**
 * Test sohbeti hiçbir kayıt bırakmaz ve WhatsApp'a göndermez:
 * - "transaction" (canlı, Postgres): gerçek veritabanında bir işlem içinde çalışır, sonunda geri alınır.
 *   Mağaza bilgileri ve kampanya arşivi yerinde okunur; ek bellek gerekmez.
 * - "copy" (yerel, PGlite): mağazanın bilgileri bellekte açılan ayrı bir veritabanına kopyalanır.
 *   PGlite tek bağlantılıdır; işlem açık kaldıkça panelin diğer istekleri beklerdi. Bu kopya ~700 MB
 *   bellek tuttuğu için canlıda kullanılmaz.
 */
export type SimulationMode = "transaction" | "copy";

export type SimulateOptions = {
  demo?: boolean;
  signal?: AbortSignal;
  mode?: SimulationMode;
  /**
   * Test müşterisinin kartı (önceki test cevabından). Lina bunu okur; cevaptan sonra kart güncellenip
   * döner (source.memory varsa). Böylece "aynı müşteri, yeni sohbet" denenebilir.
   */
  memory?: string | null;
};

export async function simulate(source: Deps, tenantId: string, history: Turn[], opts: SimulateOptions = {}) {
  const mode = opts.mode ?? "copy";
  const run = (db: DB) => runTest(source, db, tenantId, history, opts.demo ?? false, opts.signal ?? new AbortController().signal, opts.memory ?? null);
  const [tenant] = await source.db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error("Mağaza bulunamadı");

  if (mode === "transaction") {
    let result: Awaited<ReturnType<typeof runTest>> | undefined;
    try {
      await source.db.transaction(async (tx) => {
        result = await run(tx as unknown as DB);
        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
    return result!;
  }

  const scratch = await openDatabase({});
  try {
    const db = scratch.db;
    await db.insert(tenants).values(tenant);
    const docs = await source.db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, tenantId));
    if (docs.length) await db.insert(knowledgeDocs).values(docs);
    const taught = await source.db.select().from(lessons).where(eq(lessons.tenantId, tenantId));
    if (taught.length) await db.insert(lessons).values(taught.map((l) => ({ ...l, createdBy: null })));
    const archive = await source.db.select().from(textArchive).where(eq(textArchive.tenantId, tenantId));
    for (let i = 0; i < archive.length; i += 500) await db.insert(textArchive).values(archive.slice(i, i + 500));
    return await run(db);
  } finally { await scratch.close(); }
}

async function runTest(source: Deps, db: DB, tenantId: string, history: Turn[], demo: boolean, signal: AbortSignal, memory: string | null) {
  // Gerçek bir müşteriyle çakışamayacak numara (90 0.. ile başlayan numara yoktur) ve ayrı bir test hattı.
  const customerPhone = `900${randomInt(1e8, 1e9)}`;
  const phoneNumberId = `sim-${randomUUID()}`;
  const masterKey = randomBytes(32).toString("base64");
  await db.insert(whatsappAccounts).values({ tenantId, phoneNumberId, accessTokenEnc: encryptSecret("sim", masterKey) });
  const replies: string[] = [];
  const deps: Deps = {
    db, masterKey, llm: source.llm, model: source.model, historyLimit: source.historyLimit,
    timeZone: source.timeZone, log: source.log,
    wa: {
      sendText: async ({ text }) => { replies.push(text); return [randomUUID()]; },
      markReadAndTyping: async () => {},
      downloadMedia: async () => { throw new Error("Test ekranı yalnızca metin destekler"); },
    },
    // Deneme siparişleri seçilmediyse canlıdaki gibi: mağazanın sipariş ve iade bağlantısı kullanılır.
    // Test numarası hiçbir siparişle eşleşmez; gerçek siparişlerde Lina doğrulama ister, bilgi paylaşmaz.
    orderSourceFor: demo ? async () => demoOrderSource(() => customerPhone) : source.orderSourceFor,
    returnsFor: demo ? async () => demoReturnsProvider() : source.returnsFor,
  };
  // Kart varsa test müşterisi önceden kayıtlı; kart, son cevaptan sonraki mesajlara kadar güncel sayılır.
  let customerId: string | undefined;
  if (memory) {
    const [customer] = await db.insert(customers).values({ tenantId, waId: customerPhone, name: "Test Müşteri" }).returning();
    customerId = customer!.id;
    await db.insert(customerMemories).values({ tenantId, customerId, text: memory });
  }
  const firstNew = history.map((t) => t.role).lastIndexOf("assistant") + 1;

  // Görünen test sohbeti yeniden kurulur; eski turlar için yapay zekâ çağrılmaz.
  let conversationId: string | undefined;
  let outcome: string = "nothing";
  for (const [index, entry] of history.entries()) {
    if (index === firstNew && customerId) {
      await db.update(customerMemories).set({ updatedAt: sql`clock_timestamp()` }).where(eq(customerMemories.customerId, customerId));
    }
    if (entry.role === "user") {
      const result = await ingestInbound(deps, { phoneNumberId, contactName: "Test Müşteri", message: {
        from: customerPhone, id: randomUUID(), timestamp: "0", type: "text", text: { body: entry.text },
      } });
      if ("conversationId" in result) conversationId = result.conversationId;
      outcome = result.outcome;
      // Son cevaptan beri yazılan mesajların hepsine tek cevap (art arda mesajlar tek yazı gibi okunur).
      if (index === history.length - 1 && result.outcome === "queued") outcome = await respond(deps, result.conversationId, { signal, isCurrent: () => !signal.aborted });
    } else if (entry.role === "team" && conversationId) {
      // Ekibin cevabı canlıdaki gibi iç bilgi olarak eklenir; son girdiyse Lina müşteriye iletir.
      await db.insert(messages).values({
        tenantId, conversationId, sender: "system", type: TEAM_ANSWER_TYPE, text: teamAnswerText(entry.question ?? "", entry.text),
      });
      if (index === history.length - 1) outcome = await respond(deps, conversationId, { signal, isCurrent: () => !signal.aborted });
    } else if (conversationId) {
      await db.insert(messages).values({ tenantId, conversationId, sender: "bot", type: "text", text: entry.text });
    }
  }
  // Bu cevapta Lina'nın ekibe sorduğu sorular (test ekranında ekip yerine siz cevaplarsınız).
  const asked = conversationId
    ? await db
        .select({ question: teamQuestions.question, context: teamQuestions.context })
        .from(teamQuestions)
        .where(and(eq(teamQuestions.conversationId, conversationId), eq(teamQuestions.status, "open")))
    : [];
  // Müşteri kartı canlıdaki gibi cevaptan sonra güncellenir (burada beklenir ki ekranda görünsün).
  let updatedMemory = memory;
  if (conversationId && source.memory && outcome !== "cancelled" && !signal.aborted) {
    const [row] = await db
      .select({ tenant: tenants, customerId: conversations.customerId })
      .from(conversations)
      .innerJoin(tenants, eq(tenants.id, conversations.tenantId))
      .where(eq(conversations.id, conversationId));
    updatedMemory = await updateMemory(
      { db, llm: source.llm, model: source.memory.model },
      { tenant: row!.tenant, customerId: row!.customerId, conversationId, now: new Date(), timeZone: source.timeZone },
    ).catch((err: unknown) => {
      source.log.error("Test müşteri kartı güncellenemedi", err);
      return memory;
    });
  }

  // Yalnızca bu test sohbetinin kayıtları (gerçek veritabanında başka konuşmalar da var).
  const runs = conversationId
    ? await db.select().from(agentRuns).where(eq(agentRuns.conversationId, conversationId)).orderBy(agentRuns.createdAt)
    : [];
  const handedOff = conversationId ? await db.select().from(handoffs).where(eq(handoffs.conversationId, conversationId)) : [];
  return {
    replies,
    outcome,
    runs: runs.map(r => ({ agent: r.agent, question: r.input, answer: r.output, error: r.error })),
    // Test geri alınsa da harcama kaybolmasın: çağıran taraf bunları "test" olarak kaydeder.
    usage: runs.map((r) => ({
      agent: r.agent,
      model: r.model,
      stopReason: r.stopReason,
      apiCalls: r.apiCalls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      durationMs: r.durationMs,
      error: r.error,
    })),
    handoffs: handedOff,
    demoHelp: demo ? DEMO_ORDERS_HELP : [],
    memory: updatedMemory,
    teamQuestions: asked,
  };
}
