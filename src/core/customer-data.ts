import { and, count, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { agentRuns, conversations, customers, media, messages } from "../db/schema.js";

export type ErasedCustomer = { messages: number; photos: number };

/**
 * Bir müşterinin bütün verisini siler (müşterinin ya da mağazanın silme talebi): kişi kaydı, konuşma, mesajlar,
 * fotoğraflar, devirler, ekibe giden bildirim ve sorular, müşteri kartı. Geri alınamaz.
 *
 * Yapay zekâ kullanım kayıtları (maliyet, süre) istatistik için kalır; ama müşterinin yazdıklarını içeren
 * girdi ve çıktı metinleri boşaltılır ve konuşmayla bağı kopar. Müşteri yeniden yazarsa yeni bir kayıt açılır.
 * Konuşma o mağazaya ait değilse null döner (başka mağazanın verisine dokunulmaz).
 */
export async function eraseCustomerData(db: DB, tenantId: string, conversationId: string): Promise<ErasedCustomer | null> {
  return db.transaction(async (tx) => {
    const [conv] = await tx
      .select({ customerId: conversations.customerId })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
      .for("update");
    if (!conv) return null;

    const [msgs] = await tx.select({ n: count() }).from(messages).where(eq(messages.conversationId, conversationId));
    const [photos] = await tx
      .select({ n: count() })
      .from(media)
      .innerJoin(messages, eq(messages.id, media.messageId))
      .where(eq(messages.conversationId, conversationId));

    await tx.update(agentRuns).set({ conversationId: null, input: null, output: null }).where(eq(agentRuns.conversationId, conversationId));
    // Konuşma, mesaj, fotoğraf, devir, bildirim, ekibe soru ve müşteri kartı müşteriye bağlıdır (cascade).
    await tx.delete(customers).where(and(eq(customers.id, conv.customerId), eq(customers.tenantId, tenantId)));
    return { messages: msgs?.n ?? 0, photos: photos?.n ?? 0 };
  });
}
