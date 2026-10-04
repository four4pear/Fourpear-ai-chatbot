import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { conversations } from "../db/schema.js";

/**
 * Ekipteyken (devralınmış, Lina susuyor) müşterinin yeniden yazdığı ve kimsenin cevaplamadığı konuşmalar:
 * son mesaj müşteriden. Devralan kişi unutursa müşteri cevapsız kalmasın diye Bekleyenler'de görünür ve
 * menüdeki sayıya girer (docs/panel.md "Bekleyenler").
 */
export async function awaitingReplyInHuman(db: DB, tenantId: string): Promise<{ id: string; since: Date | null }[]> {
  const lastSender = sql<string>`(
    select m.sender from messages m
    where m.conversation_id = ${conversations.id}
      and m.type not in ('note', 'reaction', 'sticker', 'system', 'request_welcome')
    order by m.created_at desc, m.seq desc
    limit 1
  )`;
  return db
    .select({ id: conversations.id, since: conversations.lastCustomerMessageAt })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.status, "human"), sql`${lastSender} = 'customer'`))
    .orderBy(conversations.lastCustomerMessageAt)
    .limit(100);
}
