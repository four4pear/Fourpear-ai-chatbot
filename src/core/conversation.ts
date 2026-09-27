import type Anthropic from "@anthropic-ai/sdk";
import { and, count, desc, eq, gte, notInArray } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  conversations,
  customers,
  handoffs,
  media,
  messages,
  resolveSettings,
  tenants,
  whatsappAccounts,
  type Conversation,
  type Message,
  type Tenant,
  type WhatsappAccount,
} from "../db/schema.js";
import { runLina, type HandoffRequest } from "../agents/lina.js";
import type { Llm } from "../agents/runner.js";
import { decryptSecret } from "../lib/crypto.js";
import type { WhatsAppSender } from "../whatsapp/client.js";
import type { InboundEvent, WaIncomingMessage } from "../whatsapp/types.js";
import { loadKnowledge } from "../knowledge/base.js";
import { businessStatus } from "./business-hours.js";
import { fixedText } from "./texts.js";

export type Deps = {
  db: DB;
  llm: Llm;
  wa: WhatsAppSender;
  model: string;
  masterKey: string;
  historyLimit: number;
  timeZone: string;
  log: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
};

export type InboundOutcome =
  | "unknown_number"
  | "duplicate"
  | "bot_disabled"
  | "human_mode"
  | "daily_limit"
  | "unsupported_type"
  | "ignored"
  | "replied"
  | "handed_off";

/** Lina'nın okuyabildiği mesaj tipleri; diğerleri sabit metinle cevaplanır. */
const UNDERSTOOD_TYPES = new Set(["text", "image"]);
/**
 * Cevap beklemeyen olaylar: emoji tepkisi, sticker (çoğunlukla teşekkür), WhatsApp sistem
 * bildirimi (ör. numara değişti), sohbeti ilk açma. Panelde görünsün diye kaydedilir;
 * cevaplanmaz, günlük sınıra sayılmaz, Lina'nın geçmişine girmez.
 */
export const SILENT_TYPES = ["reaction", "sticker", "system", "request_welcome"];
const CLAUDE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Token maliyetini sınırlamak için geçmişte görsel olarak gönderilecek son fotoğraf sayısı. */
const MAX_IMAGES_IN_HISTORY = 3;

type WaTarget = { phoneNumberId: string; accessToken: string; to: string };

/** WhatsApp'tan gelen tek bir müşteri mesajını uçtan uca işler (bkz. docs/lina-davranis.md). */
export async function handleInbound(deps: Deps, event: InboundEvent): Promise<InboundOutcome> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();

  const [row] = await db
    .select({ account: whatsappAccounts, tenant: tenants })
    .from(whatsappAccounts)
    .innerJoin(tenants, eq(tenants.id, whatsappAccounts.tenantId))
    .where(eq(whatsappAccounts.phoneNumberId, event.phoneNumberId));
  if (!row) {
    deps.log.warn(`Tanımsız phone_number_id için mesaj geldi: ${event.phoneNumberId}`);
    return "unknown_number";
  }
  const { account, tenant } = row;
  const settings = resolveSettings(tenant.settings);
  const { message } = event;

  const conversation = await findOrCreateConversation(db, tenant, account, message.from, event.contactName);

  const inserted = await db
    .insert(messages)
    .values({
      tenantId: tenant.id,
      conversationId: conversation.id,
      sender: "customer",
      type: message.type,
      text: messageText(message),
      waMessageId: message.id,
      meta: message.type === "text" ? null : { raw: message },
    })
    .onConflictDoNothing({ target: messages.waMessageId })
    .returning({ id: messages.id });
  // Meta aynı webhook'u tekrar gönderebilir.
  if (inserted.length === 0) return "duplicate";
  const messageId = inserted[0]!.id;

  // "Yazıyor…" göstergesi de gönderilmez: müşteri cevap bekleyip boşa kalmasın.
  if (SILENT_TYPES.includes(message.type)) return "ignored";

  await db
    .update(conversations)
    .set({ lastCustomerMessageAt: now, updatedAt: now })
    .where(eq(conversations.id, conversation.id));

  const accessToken = decryptSecret(account.accessTokenEnc, deps.masterKey);
  const wa: WaTarget = { phoneNumberId: account.phoneNumberId, accessToken, to: message.from };
  deps.wa.markReadAndTyping({ ...wa, messageId: message.id }).catch((err) => deps.log.warn("Okundu bilgisi gönderilemedi", err));

  // Fotoğraf, bot kapalı ya da ekipte olsa da saklanır: ekip panelde görür.
  if (message.type === "image" && message.image?.id) {
    await storeImage(deps, tenant.id, messageId, accessToken, message.image.id);
  }

  if (!settings.botEnabled) return "bot_disabled";
  // Ekipten biri devraldıysa Lina susar. Devir kuyruğunda ("waiting") cevap vermeye devam eder.
  if (conversation.status === "human") return "human_mode";

  const todayCount = await countCustomerMessagesToday(db, conversation.id, deps.timeZone, now);
  const limit = settings.dailyMessageLimit;
  if (todayCount > limit) {
    // Uyarı sadece sınır ilk aşıldığında bir kez gönderilir.
    if (todayCount === limit + 1) await sendAndStore(deps, tenant, conversation, wa, fixedText(settings, "dailyLimit"), "system");
    return "daily_limit";
  }

  if (!UNDERSTOOD_TYPES.has(message.type)) {
    await sendAndStore(deps, tenant, conversation, wa, fixedText(settings, "unsupported"), "system");
    return "unsupported_type";
  }

  const [history, firstContact, openHandoff, knowledge] = await Promise.all([
    loadHistory(db, conversation.id, deps.historyLimit),
    isFirstContact(db, conversation.id),
    findOpenHandoff(db, conversation.id),
    loadKnowledge(db, tenant),
  ]);
  const turn = {
    firstContact,
    business: businessStatus(settings.businessHours, deps.timeZone, now),
    openHandoff: openHandoff && { reason: openHandoff.reason, summary: openHandoff.summary },
  };
  const ctx = { db, llm: deps.llm, model: deps.model, tenantId: tenant.id, conversationId: conversation.id };
  const lastText = messageText(message) ?? `[${message.type}]`;

  let reply: string;
  let handoff: HandoffRequest | null;
  try {
    const result = await runLina(ctx, tenant, history, turn, knowledge);
    if (result.kind === "failed") {
      reply = fixedText(settings, "failure");
      handoff = { reason: "other", summary: `Asistan cevap üretemedi (stop_reason: ${result.stopReason}). Son mesaj: "${lastText}"` };
    } else {
      reply = result.text;
      handoff = result.handoff;
    }
  } catch (err) {
    deps.log.error(`Lina çalışırken hata (tenant=${tenant.slug})`, err);
    reply = fixedText(settings, "failure");
    handoff = { reason: "other", summary: `Teknik hata nedeniyle cevap verilemedi. Son mesaj: "${lastText}"` };
  }

  if (handoff) await recordHandoff(db, tenant.id, conversation.id, handoff, openHandoff, now);
  await sendAndStore(deps, tenant, conversation, wa, reply, "bot");
  return handoff ? "handed_off" : "replied";
}

function messageText(message: WaIncomingMessage): string | null {
  if (message.type === "text") return message.text?.body ?? "";
  if (message.type === "image") return message.image?.caption?.trim() || null;
  return null;
}

async function storeImage(deps: Deps, tenantId: string, messageId: string, accessToken: string, waMediaId: string) {
  try {
    const { data, mimeType } = await deps.wa.downloadMedia({ accessToken, mediaId: waMediaId });
    await deps.db.insert(media).values({ tenantId, messageId, waMediaId, mimeType, sizeBytes: data.length, data });
  } catch (err) {
    deps.log.error(`Fotoğraf indirilemedi (media=${waMediaId})`, err);
  }
}

async function findOrCreateConversation(
  db: DB,
  tenant: Tenant,
  account: WhatsappAccount,
  waId: string,
  name: string | undefined,
): Promise<Conversation> {
  const [customer] = await db
    .insert(customers)
    .values({ tenantId: tenant.id, waId, name })
    .onConflictDoUpdate({
      target: [customers.tenantId, customers.waId],
      // İsim gelmediyse mevcut ismi koru.
      set: name ? { name } : { waId },
    })
    .returning();

  await db
    .insert(conversations)
    .values({ tenantId: tenant.id, customerId: customer!.id, whatsappAccountId: account.id })
    .onConflictDoNothing({ target: conversations.customerId });
  const [conversation] = await db.select().from(conversations).where(eq(conversations.customerId, customer!.id));
  return conversation!;
}

async function countCustomerMessagesToday(db: DB, conversationId: string, timeZone: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.sender, "customer"),
        notInArray(messages.type, SILENT_TYPES),
        gte(messages.createdAt, startOfToday(timeZone, now)),
      ),
    );
  return row?.n ?? 0;
}

/** Lina bu müşteriye daha önce hiç yazmadıysa ilk temastır. */
async function isFirstContact(db: DB, conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.sender, "bot")));
  return (row?.n ?? 0) === 0;
}

async function findOpenHandoff(db: DB, conversationId: string) {
  const [row] = await db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), eq(handoffs.status, "open")))
    .orderBy(desc(handoffs.createdAt))
    .limit(1);
  return row ?? null;
}

/** Verilen saat diliminde bugünün başlangıç anı. */
export function startOfToday(timeZone: string, now = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const elapsedMs = ((+parts.hour! * 60 + +parts.minute!) * 60 + +parts.second!) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - elapsedMs);
}

type HistoryRow = Pick<Message, "sender" | "text" | "type"> & {
  image?: { mimeType: string; data: Buffer } | null;
};

async function loadHistory(db: DB, conversationId: string, limit: number): Promise<Anthropic.MessageParam[]> {
  const rows = await db
    .select({ message: messages, image: { mimeType: media.mimeType, data: media.data } })
    .from(messages)
    .leftJoin(media, eq(media.messageId, messages.id))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  // Rows yeniden eskiye sıralı: yalnızca en yeni birkaç fotoğraf görsel olarak gider.
  let imagesLeft = MAX_IMAGES_IN_HISTORY;
  const history: HistoryRow[] = rows.map(({ message, image }) => {
    const usable = image && CLAUDE_IMAGE_TYPES.has(image.mimeType) && image.data.length <= MAX_IMAGE_BYTES;
    const keep = usable && imagesLeft-- > 0;
    return { ...message, image: keep ? image : null };
  });
  return toClaudeMessages(history.reverse());
}

/**
 * Kayıtlı mesajları Claude formatına çevirir: müşteri → user, bot/ekip → assistant.
 * Art arda aynı roldeki mesajlar birleştirilir; geçmiş her zaman user ile başlar.
 */
export function toClaudeMessages(rows: HistoryRow[]): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: Anthropic.ContentBlockParam[] }[] = [];
  for (const row of rows) {
    if (row.sender === "system" || SILENT_TYPES.includes(row.type)) continue;
    const role = row.sender === "customer" ? "user" : "assistant";
    const blocks: Anthropic.ContentBlockParam[] = [];

    if (row.type === "image") {
      if (row.image) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: row.image.mimeType as Anthropic.Base64ImageSource["media_type"],
            data: row.image.data.toString("base64"),
          },
        });
        blocks.push({ type: "text", text: row.text ? `[fotoğraf] ${row.text}` : "[fotoğraf]" });
      } else {
        blocks.push({ type: "text", text: row.text ? `[müşteri fotoğraf gönderdi] ${row.text}` : "[müşteri fotoğraf gönderdi]" });
      }
    } else {
      let text = row.text ?? `[müşteri ${row.type} gönderdi]`;
      if (row.sender === "agent") text = `(Mağaza ekibi yazdı) ${text}`;
      blocks.push({ type: "text", text });
    }

    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

/** Açık devir varsa yeni talep ona eklenir; yoksa yeni devir açılır ve konuşma kuyruğa düşer. */
async function recordHandoff(
  db: DB,
  tenantId: string,
  conversationId: string,
  handoff: HandoffRequest,
  open: { id: string; summary: string } | null,
  now: Date,
) {
  if (open) {
    await db
      .update(handoffs)
      .set({ summary: `${open.summary}\n\n[Ek talep – ${handoff.reason}] ${handoff.summary}` })
      .where(eq(handoffs.id, open.id));
    return;
  }
  await db.insert(handoffs).values({ tenantId, conversationId, reason: handoff.reason, summary: handoff.summary });
  await db
    .update(conversations)
    .set({ status: "waiting", updatedAt: now })
    .where(and(eq(conversations.id, conversationId), eq(conversations.status, "bot")));
}

async function sendAndStore(
  deps: Deps,
  tenant: Tenant,
  conversation: Conversation,
  wa: WaTarget,
  text: string,
  sender: "bot" | "system",
) {
  // Önce kaydet: gönderim başarısız olsa da panelde ne denendiği görünsün.
  const [stored] = await deps.db
    .insert(messages)
    .values({ tenantId: tenant.id, conversationId: conversation.id, sender, text })
    .returning({ id: messages.id });
  try {
    const ids = await deps.wa.sendText({ ...wa, text });
    await deps.db
      .update(messages)
      .set({ waMessageId: ids[0] ?? null, meta: { waMessageIds: ids } })
      .where(eq(messages.id, stored!.id));
  } catch (err) {
    deps.log.error(`WhatsApp mesajı gönderilemedi (tenant=${tenant.slug})`, err);
    await deps.db
      .update(messages)
      .set({ meta: { sendError: err instanceof Error ? err.message : String(err) } })
      .where(eq(messages.id, stored!.id));
  }
}
