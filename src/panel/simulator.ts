import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDatabase } from "../db/client.js";
import { agentRuns, handoffs, knowledgeDocs, tenants, textArchive, whatsappAccounts } from "../db/schema.js";
import { ingestInbound, respond, type Deps } from "../core/conversation.js";
import { encryptSecret } from "../lib/crypto.js";
import { demoOrderSource, DEMO_ORDERS_HELP } from "../orders/demo.js";

/** Each test runs in an isolated database; no real customer records or WhatsApp sender are used. */
export async function simulate(source: Deps, tenantId: string, history: { role: "user" | "assistant"; text: string }[], demo: boolean) {
  const [tenant] = await source.db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error("Mağaza bulunamadı");
  const memory = await openDatabase({});
  try {
    const db = memory.db;
    await db.insert(tenants).values(tenant);
    const docs = await source.db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, tenantId));
    if (docs.length) await db.insert(knowledgeDocs).values(docs);
    const archive = await source.db.select().from(textArchive).where(eq(textArchive.tenantId, tenantId));
    for (let i = 0; i < archive.length; i += 500) await db.insert(textArchive).values(archive.slice(i, i + 500));
    const masterKey = randomBytes(32).toString("base64");
    await db.insert(whatsappAccounts).values({ tenantId, phoneNumberId: "sim", accessTokenEnc: encryptSecret("sim", masterKey) });
    const replies: string[] = [];
    const deps: Deps = {
      db, masterKey, llm: source.llm, model: source.model, historyLimit: source.historyLimit,
      timeZone: source.timeZone, log: source.log,
      wa: {
        sendText: async ({ text }) => { replies.push(text); return [randomUUID()]; },
        markReadAndTyping: async () => {},
        downloadMedia: async () => { throw new Error("Test ekranı yalnızca metin destekler"); },
      },
      orderSourceFor: demo ? async () => demoOrderSource(() => "905300000001") : undefined,
    };
    // Reconstruct only the visible test transcript, without invoking the model for old turns.
    const { messages } = await import("../db/schema.js");
    let conversationId: string | undefined;
    let outcome: string = "nothing";
    for (const [index, entry] of history.entries()) {
      if (entry.role === "user") {
        const result = await ingestInbound(deps, { phoneNumberId: "sim", contactName: "Test Müşteri", message: {
          from: "905300000001", id: randomUUID(), timestamp: "0", type: "text", text: { body: entry.text },
        } });
        if ("conversationId" in result) conversationId = result.conversationId;
        outcome = result.outcome;
        if (index === history.length - 1 && result.outcome === "queued") outcome = await respond(deps, result.conversationId, { signal: new AbortController().signal, isCurrent: () => true });
      } else if (conversationId) {
        await db.insert(messages).values({ tenantId, conversationId, sender: "bot", type: "text", text: entry.text });
      }
    }
    const runs = await db.select().from(agentRuns).orderBy(agentRuns.createdAt);
    return { replies, outcome, runs: runs.map(r => ({ agent: r.agent, question: r.input, answer: r.output, error: r.error })), handoffs: await db.select().from(handoffs), demoHelp: demo ? DEMO_ORDERS_HELP : [] };
  } finally { await memory.close(); }
}
