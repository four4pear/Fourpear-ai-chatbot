import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { recordTeamQuestions } from "../src/core/team-questions.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { conversations, customers, teamQuestions, tenants, whatsappAccounts } from "../src/db/schema.js";

let database: Database;
let tenantId: string;
let conversationId: string;
let otherConversationId: string;

beforeAll(async () => {
  database = await openDatabase({});
  const { db } = database;
  const [t] = await db.insert(tenants).values({ slug: "maius", name: "MAIUS" }).returning();
  tenantId = t!.id;
  const [acc] = await db.insert(whatsappAccounts).values({ tenantId, phoneNumberId: "pn", accessTokenEnc: "x" }).returning();
  const make = async (wa: string) => {
    const [c] = await db.insert(customers).values({ tenantId, waId: wa }).returning();
    const [conv] = await db.insert(conversations).values({ tenantId, customerId: c!.id, whatsappAccountId: acc!.id }).returning();
    return conv!.id;
  };
  conversationId = await make("905320000001");
  otherConversationId = await make("905320000002");
});
afterAll(() => database.close());

const ask = (conversation: string, questions: string[]) =>
  recordTeamQuestions(database.db, { tenantId, conversationId: conversation, customerMessage: "msg", items: questions.map((question) => ({ question, context: "c" })) });
const rows = (conversation: string) => database.db.select().from(teamQuestions).where(eq(teamQuestions.conversationId, conversation));

describe("ekibe sorulan soru yinelenmez", () => {
  it("aynı soru bu konuşmada cevap beklerken tekrar sorulursa ikincisi açılmaz (büyük/küçük harf ve noktalama farkı yok sayılır)", async () => {
    expect(await ask(conversationId, ["MO-9013 iadesinin parası ne zaman yatar?"])).toHaveLength(1);
    expect(await ask(conversationId, ["mo-9013 iadesinin parası ne zaman yatar"])).toHaveLength(0);
    expect(await rows(conversationId)).toHaveLength(1);
  });

  it("aynı turdaki özdeş sorular tek sayılır; farklı soru açılır", async () => {
    expect(await ask(conversationId, ["Kargo ücreti kimde?", "kargo ücreti kimde", "Hediye paketi var mı?"])).toHaveLength(2);
    expect(await rows(conversationId)).toHaveLength(3);
  });

  it("cevaplanmış soru tekrar sorulabilir; başka konuşmanın sorusu etkilenmez", async () => {
    await database.db.update(teamQuestions).set({ status: "answered", answer: "x" }).where(eq(teamQuestions.conversationId, conversationId));
    expect(await ask(conversationId, ["Kargo ücreti kimde?"])).toHaveLength(1);
    expect(await ask(otherConversationId, ["Kargo ücreti kimde?"])).toHaveLength(1);
  });
});
