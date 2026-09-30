import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { eq, TransactionRollbackError } from "drizzle-orm";
import { openDatabase, type DB } from "../db/client.js";
import { agentRuns, handoffs, knowledgeDocs, messages, tenants, textArchive, whatsappAccounts } from "../db/schema.js";
import { ingestInbound, respond, type Deps } from "../core/conversation.js";
import { encryptSecret } from "../lib/crypto.js";
import { demoOrderSource, DEMO_ORDERS_HELP } from "../orders/demo.js";

type Turn = { role: "user" | "assistant"; text: string };

/**
 * Test sohbeti hiçbir kayıt bırakmaz ve WhatsApp'a göndermez:
 * - "transaction" (canlı, Postgres): gerçek veritabanında bir işlem içinde çalışır, sonunda geri alınır.
 *   Mağaza bilgileri ve kampanya arşivi yerinde okunur; ek bellek gerekmez.
 * - "copy" (yerel, PGlite): mağazanın bilgileri bellekte açılan ayrı bir veritabanına kopyalanır.
 *   PGlite tek bağlantılıdır; işlem açık kaldıkça panelin diğer istekleri beklerdi. Bu kopya ~700 MB
 *   bellek tuttuğu için canlıda kullanılmaz.
 */
export type SimulationMode = "transaction" | "copy";

export async function simulate(
  source: Deps,
  tenantId: string,
  history: Turn[],
  demo: boolean,
  signal: AbortSignal = new AbortController().signal,
  mode: SimulationMode = "copy",
) {
  const [tenant] = await source.db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error("Mağaza bulunamadı");

  if (mode === "transaction") {
    let result: Awaited<ReturnType<typeof run>> | undefined;
    try {
      await source.db.transaction(async (tx) => {
        result = await run(source, tx as unknown as DB, tenantId, history, demo, signal);
        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
    return result!;
  }

  const memory = await openDatabase({});
  try {
    const db = memory.db;
    await db.insert(tenants).values(tenant);
    const docs = await source.db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, tenantId));
    if (docs.length) await db.insert(knowledgeDocs).values(docs);
    const archive = await source.db.select().from(textArchive).where(eq(textArchive.tenantId, tenantId));
    for (let i = 0; i < archive.length; i += 500) await db.insert(textArchive).values(archive.slice(i, i + 500));
    return await run(source, db, tenantId, history, demo, signal);
  } finally { await memory.close(); }
}

async function run(source: Deps, db: DB, tenantId: string, history: Turn[], demo: boolean, signal: AbortSignal) {
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
    orderSourceFor: demo ? async () => demoOrderSource(() => customerPhone) : undefined,
  };
  // Görünen test sohbeti yeniden kurulur; eski turlar için yapay zekâ çağrılmaz.
  let conversationId: string | undefined;
  let outcome: string = "nothing";
  for (const [index, entry] of history.entries()) {
    if (entry.role === "user") {
      const result = await ingestInbound(deps, { phoneNumberId, contactName: "Test Müşteri", message: {
        from: customerPhone, id: randomUUID(), timestamp: "0", type: "text", text: { body: entry.text },
      } });
      if ("conversationId" in result) conversationId = result.conversationId;
      outcome = result.outcome;
      // Son cevaptan beri yazılan mesajların hepsine tek cevap (art arda mesajlar tek yazı gibi okunur).
      if (index === history.length - 1 && result.outcome === "queued") outcome = await respond(deps, result.conversationId, { signal, isCurrent: () => !signal.aborted });
    } else if (conversationId) {
      await db.insert(messages).values({ tenantId, conversationId, sender: "bot", type: "text", text: entry.text });
    }
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
    handoffs: handedOff,
    demoHelp: demo ? DEMO_ORDERS_HELP : [],
  };
}
