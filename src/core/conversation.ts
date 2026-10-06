import type Anthropic from "@anthropic-ai/sdk";
import { and, count, desc, eq, gte, inArray, ne, notInArray } from "drizzle-orm";
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
  type TenantSettings,
  type WhatsappAccount,
} from "../db/schema.js";
import { ensureIntro } from "../agents/prompts.js";
import { runLina, type HandoffRequest } from "../agents/lina.js";
import type { OrderFindings } from "../agents/orders.js";
import { CancelledError, describeLlmError, type Llm } from "../agents/runner.js";
import { decryptSecret } from "../lib/crypto.js";
import type { OrderSource } from "../orders/types.js";
import type { ReturnsProvider } from "../returns/provider.js";
import type { WhatsAppSender } from "../whatsapp/client.js";
import type { InboundEvent, WaIncomingMessage } from "../whatsapp/types.js";
import { loadKnowledge } from "../knowledge/base.js";
import { loadLessons, withLessons } from "./lessons.js";
import { loadMemory, updateMemory } from "./memory.js";
import { openTeamQuestions, recordTeamQuestions, TEAM_ANSWER_TYPE, type AskedQuestion } from "./team-questions.js";
import { businessStatus } from "./business-hours.js";
import type { Transcriber } from "./transcribe.js";
import type { EventBus } from "./events.js";
import { identityLocked, recordLimitNotification, recordOrderNotification } from "./notifications.js";
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
  /** Panellere canlı sinyal (yoksa sinyal gönderilmez). */
  events?: EventBus;
  /** Mağaza ayarı yerine kullanılacak bekleme (testler ve `npm run chat -- --bekleme`). */
  replyDelayOverrideMs?: number;
  /** Mağazanın siparişleri (Shopify uygulaması kuruluysa); yoksa sipariş uzmanı kapalıdır. */
  orderSourceFor?: (tenantId: string) => Promise<OrderSource | null>;
  /** Mağazanın iade sistemi bağlantısı (varsa, yalnızca okuma). */
  returnsFor?: (tenantId: string) => Promise<ReturnsProvider | null>;
  /**
   * Müşteri kartı (core/memory.ts): her cevaptan sonra arka planda güncellenir. `schedule` aynı
   * müşterinin güncellemelerini sıraya koyar; yoksa güncelleme kartı okumaz ama yazmaz (test ekranı).
   */
  memory?: { model: string; schedule?: (customerId: string, task: () => Promise<void>) => void };
  /** Sesli mesajı yazıya çevirir; yoksa sesli mesajlara sabit "yazarak iletin" metni gider. */
  transcribe?: Transcriber;
};

/** Gelen mesajın alınma sonucu. "queued": cevap zamanlayıcıya bırakıldı (bkz. reply-scheduler.ts). */
export type IngestResult =
  | { outcome: "unknown_number" | "duplicate" }
  | { outcome: "ignored" | "bot_disabled" | "human_mode" | "outside_hours" | "daily_limit"; conversationId: string }
  | {
      outcome: "queued";
      conversationId: string;
      tenantId: string;
      /** Mağaza ayarı: son mesajdan sonra bekleme ve üst sınır. */
      delayMs: number;
      maxWaitMs: number;
      /** Bekleme boyunca "yazıyor…" göstergesini yenilemek için. */
      typing: { wa: WaTarget; messageId: string };
    };

/** Toplu cevabın sonucu. "cancelled": hazırlanırken yeni mesaj geldi ya da ekip devraldı; gönderilmedi. */
export type RespondOutcome =
  | "gone"
  | "bot_disabled"
  | "outside_hours"
  | "human_mode"
  | "nothing"
  | "unsupported_type"
  | "cancelled"
  | "replied"
  | "handed_off";

/** Zamanlayıcının cevaba verdiği kontrol: iptal sinyali ve "hâlâ en güncel mi?" sorusu. */
export type RespondControl = { signal: AbortSignal; isCurrent: () => boolean };

/** Lina'nın okuyabildiği mesaj tipleri; diğerleri sabit metinle cevaplanır. */
/** Ekibin cevabı ("Lina soruyor") da Lina'nın okuyup müşteriye ileteceği bir girdidir. */
const UNDERSTOOD_TYPES = new Set(["text", "image", TEAM_ANSWER_TYPE]);
/**
 * Cevap beklemeyen olaylar: emoji tepkisi, sticker (çoğunlukla teşekkür), WhatsApp sistem
 * bildirimi (ör. numara değişti), sohbeti ilk açma. Panelde görünsün diye kaydedilir;
 * cevaplanmaz, günlük sınıra sayılmaz, Lina'nın geçmişine girmez.
 */
/** Talimatta Lina'ya gösterilen ekip cevabı sayısı: bu turda iletilecekler ve öncekilerden birkaçı. */
const MAX_TEAM_ANSWERS_IN_CONTEXT = 5;
/** Yalnızca ekibin cevabı geldiğinde geçmişin sonuna eklenir; müşteri yazsa da bir anlam taşımaz. */
const NO_NEW_MESSAGE = "[Müşteri yeni bir mesaj yazmadı.]";
export const SILENT_TYPES = ["reaction", "sticker", "system", "request_welcome"];
const CLAUDE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Token maliyetini sınırlamak için geçmişte görsel olarak gönderilecek son fotoğraf sayısı. */
const MAX_IMAGES_IN_HISTORY = 3;

export type WaTarget = { phoneNumberId: string; accessToken: string; to: string; /** Zernio konuşma kimliği (Meta'da boş). */ chatRef?: string };

/**
 * WhatsApp'tan gelen bir müşteri mesajını alır: kaydeder, okundu + "yazıyor…" gösterir,
 * fotoğrafı saklar ve kontrolleri yapar. Lina'yı çağırmaz: cevap, müşteri susunca
 * zamanlayıcı üzerinden `respond` ile toplu verilir (docs/lina-davranis.md "Art arda mesajlar").
 */
export async function ingestInbound(deps: Deps, event: InboundEvent): Promise<IngestResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();

  const [row] = await db
    .select({ account: whatsappAccounts, tenant: tenants })
    .from(whatsappAccounts)
    .innerJoin(tenants, eq(tenants.id, whatsappAccounts.tenantId))
    .where(eq(whatsappAccounts.phoneNumberId, event.phoneNumberId));
  if (!row) {
    deps.log.warn(`Tanımsız phone_number_id için mesaj geldi: ${event.phoneNumberId}`);
    return { outcome: "unknown_number" };
  }
  const { account, tenant } = row;
  const settings = resolveSettings(tenant.settings);
  const { message } = event;

  const conversation = await findOrCreateConversation(db, tenant, account, message.from, event.contactName, event.chatRef);
  const conversationId = conversation.id;

  const inserted = await db
    .insert(messages)
    .values({
      tenantId: tenant.id,
      conversationId,
      sender: "customer",
      type: message.type,
      text: messageText(message),
      waMessageId: message.id,
      meta: message.type === "text" ? null : { raw: message },
    })
    .onConflictDoNothing({ target: messages.waMessageId })
    .returning({ id: messages.id });
  // Meta aynı webhook'u tekrar gönderebilir.
  if (inserted.length === 0) return { outcome: "duplicate" };
  const messageId = inserted[0]!.id;

  // "Yazıyor…" göstergesi de gönderilmez: müşteri cevap bekleyip boşa kalmasın.
  if (SILENT_TYPES.includes(message.type)) {
    deps.events?.publish(tenant.id, { type: "message", conversationId });
    return { outcome: "ignored", conversationId };
  }

  await db
    .update(conversations)
    .set({ lastCustomerMessageAt: now, updatedAt: now })
    .where(eq(conversations.id, conversationId));

  const accessToken = decryptSecret(account.accessTokenEnc, deps.masterKey);
  const wa: WaTarget = { phoneNumberId: account.phoneNumberId, accessToken, to: message.from, chatRef: event.chatRef };
  // Lina cevap vermeyecekse (kapalı, ekipte ya da günlük sınır aşıldı) "yazıyor…" gösterilmez:
  // müşteri cevap bekleyip boşa kalmasın. Mesaj yine okundu işaretlenir.
  const limit = settings.dailyMessageLimit;
  const overLimit = (await countCustomerMessagesToday(db, conversationId, deps.timeZone, now)) > limit;
  const outsideHours = botClosedByHours(settings, deps.timeZone, now);
  const silent = !settings.botEnabled || conversation.status === "human" || outsideHours || overLimit;
  deps.wa
    .markReadAndTyping({ ...wa, messageId: message.id, typing: !silent })
    .catch((err) => deps.log.warn("Okundu bilgisi gönderilemedi", err));

  // Fotoğraf, bot kapalı ya da ekipte olsa da saklanır: ekip panelde görür.
  if (message.type === "image" && message.image?.id) {
    await storeImage(deps, tenant.id, messageId, accessToken, message.image.id);
  }
  // Sesli mesaj: yazıya çevrilip mesajın metni olur; ses kaydı saklanmaz. Çevrilemezse (servis yok, hata,
  // sessizlik) metin boş kalır ve müşteriye "yazarak iletin" denir.
  if (message.type === "audio" && message.audio?.id && deps.transcribe) {
    const text = await transcribeVoice(deps, accessToken, message.audio.id);
    if (text) await db.update(messages).set({ text }).where(eq(messages.id, messageId));
  }
  // Fotoğraf kaydedildikten sonra: panel mesajı açtığında fotoğraf da hazır olsun.
  deps.events?.publish(tenant.id, { type: "message", conversationId });

  if (!settings.botEnabled) return { outcome: "bot_disabled", conversationId };
  // Ekipten biri devraldıysa Lina susar. Devir kuyruğunda ("waiting") cevap vermeye devam eder.
  if (conversation.status === "human") return { outcome: "human_mode", conversationId };

  if (overLimit) {
    // Spam ve bot döngüsüne karşı fatura koruması: Lina yeni cevap hazırlamaz, müşteriye sınırdan söz edilmez.
    // Ekibe günde bir kez önemli bildirim düşer. Her sınır üstü mesajda bakılır: sınır konuşma ekipteyken
    // aşılmış ya da ilk kayıt başarısız olmuş olabilir.
    await recordLimitNotification(deps, {
      tenantId: tenant.id,
      conversationId,
      limit,
      lastMessage: messageText(message) ?? "",
      now,
      since: startOfToday(deps.timeZone, now),
    }).catch((err: unknown) => deps.log.error(`Sınır bildirimi kaydedilemedi (tenant=${tenant.slug})`, err));
    return { outcome: "daily_limit", conversationId };
  }
  // Mesai saati dışında Lina susar; mesaj kaydedilir, mesai açılınca cevaplanır (index.ts açılış işi).
  if (outsideHours) return { outcome: "outside_hours", conversationId };

  return {
    outcome: "queued",
    conversationId,
    tenantId: tenant.id,
    delayMs: settings.replyDelaySeconds * 1000,
    maxWaitMs: settings.maxReplyWaitSeconds * 1000,
    typing: { wa, messageId: message.id },
  };
}

/**
 * Son cevaptan bu yana gelen bütün müşteri mesajlarına tek cevap verir.
 * Göndermeden hemen önce hâlâ en güncel olduğu ve ekibin devralmadığı yeniden kontrol edilir;
 * değilse cevap gönderilmez ("cancelled"). Böylece cevaplar asla karışmaz.
 */
export async function respond(deps: Deps, conversationId: string, ctl: RespondControl): Promise<RespondOutcome> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();

  const [row] = await db
    .select({ conversation: conversations, tenant: tenants, account: whatsappAccounts, waId: customers.waId, chatRef: customers.channelRef })
    .from(conversations)
    .innerJoin(tenants, eq(tenants.id, conversations.tenantId))
    .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, conversations.whatsappAccountId))
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .where(eq(conversations.id, conversationId));
  if (!row) return "gone";
  const { conversation, tenant, account, waId, chatRef } = row;
  const settings = resolveSettings(tenant.settings);
  if (!settings.botEnabled) return "bot_disabled";
  if (conversation.status === "human") return "human_mode";
  if (botClosedByHours(settings, deps.timeZone, now)) return "outside_hours";

  const batch = await unansweredCustomerMessages(db, conversationId);
  if (batch.length === 0) return "nothing";
  const pendingAnswers = batch.filter((m) => m.type === TEAM_ANSWER_TYPE).length;

  const wa: WaTarget = {
    phoneNumberId: account.phoneNumberId,
    accessToken: decryptSecret(account.accessTokenEnc, deps.masterKey),
    to: waId,
    chatRef: chatRef ?? undefined,
  };
  // Hazırlanırken yeni mesaj geldiyse ya da ekip devraldıysa bu cevap artık gönderilmez.
  const stillOurs = async () => {
    if (!ctl.isCurrent() || ctl.signal.aborted) return false;
    const [fresh] = await db.select({ status: conversations.status }).from(conversations).where(eq(conversations.id, conversationId));
    return fresh?.status !== "human";
  };

  // Toplu mesajda Lina'nın okuyabileceği bir şey yoksa (sadece ses/video…) sabit metin bir kez.
  if (!batch.some((m) => UNDERSTOOD_TYPES.has(m.type) || (m.type === "audio" && m.text))) {
    if (!(await stillOurs())) return "cancelled";
    await sendAndStore(deps, tenant, conversation, wa, fixedText(settings, "unsupported"), "system", answeredThroughOf(batch));
    return "unsupported_type";
  }

  // Sipariş ve iade bağlantısı alınamazsa Lina onlarsız çalışır (sipariş sorularında devreder).
  const optional = <T>(task: Promise<T> | undefined, what: string): Promise<T | null> =>
    (task ?? Promise.resolve(null)).catch((err: unknown) => {
      deps.log.error(`${what} alınamadı (tenant=${tenant.slug})`, err);
      return null;
    });
  const [history, firstContact, openHandoff, storeKnowledge, lessons, memory, askedTeam, teamAnswers, locked, orderSource, returns] = await Promise.all([
    loadHistory(db, conversationId, deps.historyLimit),
    isFirstContact(db, conversationId),
    findOpenHandoff(db, conversationId),
    loadKnowledge(db, tenant),
    loadLessons(db, tenant.id),
    loadMemory(db, conversation.customerId),
    openTeamQuestions(db, conversationId),
    recentTeamAnswers(db, conversationId),
    identityLocked(db, conversationId, now),
    optional(deps.orderSourceFor?.(tenant.id), "Sipariş kaynağı"),
    optional(deps.returnsFor?.(tenant.id), "İade sistemi bağlantısı"),
  ]);
  const turn = {
    // Kartı olan müşteri daha önce yazmıştır (ör. eski mesajları silinmiş olsa da): yeniden tanıtım yok.
    firstContact: firstContact && !memory,
    business: businessStatus(settings.businessHours, deps.timeZone, now),
    openHandoff: openHandoff && { reason: openHandoff.reason, summary: openHandoff.summary },
    memory,
    askedTeam,
    // En yeniler (bu turda iletilecekler) cevapsız mesajların içindekilerdir; gerisi daha önce iletildi.
    teamAnswers: {
      fresh: teamAnswers.slice(0, pendingAnswers).reverse(),
      earlier: teamAnswers.slice(pendingAnswers).reverse(),
    },
  };
  // Yalnızca ekibin cevabı geldiyse müşteri yeni bir şey yazmamıştır; Claude'a giden geçmiş müşteriyle bitmeli.
  if (history.at(-1)?.role !== "user") history.push({ role: "user", content: [{ type: "text", text: NO_NEW_MESSAGE }] });
  const ctx = { db, llm: deps.llm, model: deps.model, tenantId: tenant.id, conversationId, signal: ctl.signal, log: deps.log };
  const orders = orderSource ? { source: orderSource, waId, timeZone: deps.timeZone, now, returns, identityLocked: locked } : null;
  // Ekibin Lina'ya cevabı iç bilgidir; müşterinin yazdığı diye bildirime ya da soruya geçmez.
  const lastText = batch
    .filter((m) => m.type !== TEAM_ANSWER_TYPE)
    .map((m) => m.text ?? `[${MEDIA_LABELS[m.type] ?? m.type}]`)
    .join(" / ");

  let reply: string;
  let handoff: HandoffRequest | null;
  let orderFindings: OrderFindings | null = null;
  let teamQuestions: AskedQuestion[] = [];
  try {
    const result = await runLina(ctx, tenant, history, turn, withLessons(storeKnowledge, lessons), orders, lessons);
    if (result.kind === "failed") {
      reply = fixedText(settings, "failure");
      handoff = { reason: "other", summary: `Asistan cevap üretemedi (stop_reason: ${result.stopReason}). Mesajlar: "${lastText}"` };
    } else {
      reply = turn.firstContact ? ensureIntro(result.text, tenant.botName) : result.text;
      handoff = result.handoff;
      orderFindings = result.orders;
      teamQuestions = result.teamQuestions;
    }
  } catch (err) {
    // İptal bir hata değildir: özür mesajı yok, devir yok.
    if (err instanceof CancelledError || ctl.signal.aborted) return "cancelled";
    // Sebep panelde devir notunda da görünür (ör. kredi bittiyse ekip bunu hemen anlar).
    const reason = describeLlmError(err);
    deps.log.error(`Lina çalışırken hata (tenant=${tenant.slug}): ${reason}`, err);
    reply = fixedText(settings, "failure");
    handoff = { reason: "other", summary: `Cevap verilemedi (${reason}). Mesajlar: "${lastText}"` };
  }

  if (!(await stillOurs())) return "cancelled";
  if (handoff) {
    await recordHandoff(db, tenant.id, conversationId, handoff, openHandoff, now);
    // Yeni devirde panelde sesli uyarı/bildirim; mevcut devre eklenen talepte sadece güncelleme.
    deps.events?.publish(tenant.id, { type: openHandoff ? "conversation" : "handoff", conversationId });
  }
  const delivery = await sendAndStore(deps, tenant, conversation, wa, reply, "bot", answeredThroughOf(batch));
  // Lina soruyor: soru panelde ekibe düşer; cevap gelince Lina müşteriye kendisi iletir.
  if (teamQuestions.length) {
    await recordTeamQuestions(db, { tenantId: tenant.id, conversationId, customerMessage: lastText, items: teamQuestions });
    deps.events?.publish(tenant.id, { type: "team_question", conversationId });
  }
  // Müşteri kartı arka planda güncellenir; cevabı geciktirmez, hatası cevabı etkilemez.
  if (deps.memory?.schedule) {
    const { model } = deps.memory;
    deps.memory.schedule(conversation.customerId, async () => {
      await updateMemory(
        { db, llm: deps.llm, model },
        { tenant, customerId: conversation.customerId, conversationId, now: deps.now?.() ?? new Date(), timeZone: deps.timeZone },
      );
    });
  }
  // Sipariş konularında devir yok: ekibe bildirim (docs/lina-davranis.md "Ekibe bildirimler").
  if (orderFindings) {
    await recordOrderNotification(deps, {
      tenantId: tenant.id,
      conversationId,
      findings: orderFindings,
      question: lastText,
      answer: reply,
      replySent: delivery.sent,
    }).catch((err: unknown) => deps.log.error(`Bildirim kaydedilemedi (tenant=${tenant.slug})`, err));
  }
  return handoff ? "handed_off" : "replied";
}

/** Ekibin Lina'ya son cevapları, yeniden eskiye (cevapsız olanlar en başta). */
async function recentTeamAnswers(db: DB, conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ text: messages.text })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.type, TEAM_ANSWER_TYPE)))
    .orderBy(desc(messages.createdAt), desc(messages.seq))
    .limit(MAX_TEAM_ANSWERS_IN_CONTEXT);
  return rows.map((r) => r.text ?? "");
}

/**
 * Son giden mesajdan (Lina, ekip ya da otomatik metin) sonra gelen müşteri mesajları, eskiden yeniye.
 * Panel notları ve tepki/sticker gibi sessiz olaylar sayılmaz.
 */
async function unansweredCustomerMessages(db: DB, conversationId: string) {
  const recent = await db
    .select({ sender: messages.sender, type: messages.type, text: messages.text, seq: messages.seq, meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), ne(messages.type, "note")))
    .orderBy(desc(messages.createdAt), desc(messages.seq))
    .limit(50);
  const batch: typeof recent = [];
  // Lina'nın cevabı, hazırlanırken gelen mesajdan SONRA kaydedilebilir. Cevap hangi mesaja kadar
  // baktığını (answeredThrough) taşır; ondan yeni müşteri mesajları cevabın arkasında bile cevapsızdır.
  let answeredThrough = -1;
  for (const m of recent) {
    if (m.seq <= answeredThrough) break;
    const mine = m.sender === "customer" || m.type === TEAM_ANSWER_TYPE;
    if (!mine) {
      const through = (m.meta as { answeredThrough?: number } | null)?.answeredThrough;
      if (typeof through !== "number") break;
      answeredThrough = Math.max(answeredThrough, through);
      continue;
    }
    // Ekibin cevabı müşteri mesajı gibi cevap bekler: Lina müşteriye iletir.
    if (!SILENT_TYPES.includes(m.type)) batch.push(m);
  }
  return batch.reverse();
}

/** Bir toplu cevabın baktığı en son mesaj: cevap kaydedilirken işaretlenir (bkz. unansweredCustomerMessages). */
const answeredThroughOf = (batch: { seq: number }[]) => Math.max(...batch.map((m) => m.seq));

/**
 * Sunucu yeniden başlarken bekleme sırasında kalmış konuşmalar: son mesajı `since`'den sonra
 * gelmiş, cevapsız müşteri mesajı olan ve ekipte olmayanlar. Açılışta zamanlayıcıya alınır.
 */
/** "Lina yalnızca mesai saatlerinde" açıkken ve şu an mesai dışıysa true. */
export function botClosedByHours(settings: TenantSettings, timeZone: string, now: Date): boolean {
  return settings.botHoursOnly && !businessStatus(settings.businessHours, timeZone, now).open;
}

export async function findUnansweredConversations(db: DB, since: Date, tenantId?: string): Promise<string[]> {
  const latest = await db
    .selectDistinctOn([messages.conversationId], {
      conversationId: messages.conversationId,
      sender: messages.sender,
      type: messages.type,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(ne(messages.type, "note"), notInArray(messages.type, SILENT_TYPES), gte(messages.createdAt, since)))
    .orderBy(messages.conversationId, desc(messages.createdAt), desc(messages.seq));
  const candidates = latest.filter((m) => m.sender === "customer" || m.type === TEAM_ANSWER_TYPE).map((m) => m.conversationId);
  if (candidates.length === 0) return [];
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(inArray(conversations.id, candidates), ne(conversations.status, "human"), tenantId ? eq(conversations.tenantId, tenantId) : undefined));
  return rows.map((r) => r.id);
}

function messageText(message: WaIncomingMessage): string | null {
  if (message.type === "text") return message.text?.body ?? "";
  if (message.type === "image") return message.image?.caption?.trim() || null;
  return null;
}

async function transcribeVoice(deps: Deps, accessToken: string, mediaId: string): Promise<string | null> {
  try {
    const audio = await deps.wa.downloadMedia({ accessToken, mediaId });
    return (await deps.transcribe!(audio)) ?? null;
  } catch (err) {
    deps.log.error("Sesli mesaj yazıya çevrilemedi", err);
    return null;
  }
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
  chatRef?: string,
): Promise<Conversation> {
  const [customer] = await db
    .insert(customers)
    .values({ tenantId: tenant.id, waId, name, channelRef: chatRef })
    .onConflictDoUpdate({
      target: [customers.tenantId, customers.waId],
      // İsim ya da konuşma kimliği gelmediyse mevcut olan korunur.
      set: { waId, ...(name ? { name } : {}), ...(chatRef ? { channelRef: chatRef } : {}) },
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
  seq?: number;
  meta?: Message["meta"];
};

/**
 * Lina cevabı hazırlarken gelen müşteri mesajı, cevaptan önce kaydedilir ama o cevap onu görmemiştir
 * (answeredThrough). Geçmişte cevabın arkasına alınır: Lina neyin cevapsız kaldığını görür.
 */
function placeLateMessages(rows: HistoryRow[]): HistoryRow[] {
  const out: HistoryRow[] = [];
  for (const row of rows) {
    const through = (row.meta as { answeredThrough?: number } | null | undefined)?.answeredThrough;
    if (row.sender === "customer" || typeof through !== "number") {
      out.push(row);
      continue;
    }
    const late: HistoryRow[] = [];
    while (out.length && out.at(-1)!.sender === "customer" && (out.at(-1)!.seq ?? 0) > through) late.unshift(out.pop()!);
    out.push(row, ...late);
  }
  return out;
}

async function loadHistory(db: DB, conversationId: string, limit: number): Promise<Anthropic.MessageParam[]> {
  const rows = await db
    .select({ message: messages, image: { mimeType: media.mimeType, data: media.data } })
    .from(messages)
    .leftJoin(media, eq(media.messageId, messages.id))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.seq))
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
 * Kayıtlı mesajları Claude formatına çevirir: müşteri → user; Lina, ekip ve otomatik mesajlar → assistant.
 * Art arda aynı roldeki mesajlar birleştirilir; geçmiş her zaman user ile başlar.
 */
export function toClaudeMessages(rows: HistoryRow[]): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: Anthropic.ContentBlockParam[] }[] = [];
  for (const row of placeLateMessages(rows)) {
    // Panel notları iç nottur; tepki/sticker cevap beklemez. Otomatik mesajlar (sabit metinler)
    // müşterinin gördüğü mesajlardır: Lina tekrar etmesin diye geçmişte yer alır.
    // Ekibin Lina'ya cevabı geçmişe konmaz: müşteri mesajlarıyla aynı yerde dursaydı müşteri aynı kalıbı
    // yazıp sahte "ekip cevabı" verebilirdi. Lina'ya sistem talimatında verilir (prompts.ts turnContext).
    if (row.type === "note" || row.type === TEAM_ANSWER_TYPE || SILENT_TYPES.includes(row.type)) continue;
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
      let text = row.text ?? `[müşteri ${MEDIA_LABELS[row.type] ?? row.type} gönderdi]`;
      // Sesli mesajın metni konuşma tanımadan gelir: yanlış duyulmuş olabilir, Lina bunu bilsin.
      if (row.type === "audio" && row.text) text = `[sesli mesaj, yazıya çevrildi] ${row.text}`;
      if (row.sender === "agent") text = `(Mağaza ekibi yazdı) ${text}`;
      blocks.push({ type: "text", text });
    }

    const last = out.at(-1);
    if (last?.role !== role) {
      out.push({ role, content: blocks });
      continue;
    }
    // Art arda mesajlar tek yazı gibi: ardışık metinler satır satır tek blokta birleşir.
    for (const block of blocks) {
      const prev = last.content.at(-1);
      if (block.type === "text" && prev?.type === "text") prev.text += `\n${block.text}`;
      else last.content.push(block);
    }
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

/** Lina'nın açamadığı içeriklerin geçmişteki Türkçe adları. */
const MEDIA_LABELS: Record<string, string> = {
  audio: "sesli mesaj",
  video: "video",
  document: "belge",
  location: "konum",
  contacts: "kişi kartı",
  interactive: "etkileşimli mesaj",
  button: "buton yanıtı",
};

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

function sendAndStore(
  deps: Deps,
  tenant: Tenant,
  conversation: Conversation,
  wa: WaTarget,
  text: string,
  sender: "bot" | "system",
  answeredThrough: number,
) {
  return deliverText(deps, { tenantId: tenant.id, conversationId: conversation.id, wa, text, sender, meta: { answeredThrough } });
}

export type DeliveryResult = { messageId: string; sent: boolean; error?: string };

/**
 * Müşteriye WhatsApp mesajı gönderir ve kaydeder (Lina, otomatik metin ya da ekip).
 * Önce kaydeder: gönderim başarısız olsa da panelde ne denendiği ve hatası görünür.
 */
export async function deliverText(
  deps: Pick<Deps, "db" | "wa" | "log" | "events">,
  opts: {
    tenantId: string;
    conversationId: string;
    wa: WaTarget;
    text: string;
    sender: "bot" | "system" | "agent";
    authorUserId?: string;
    /** Mesajla birlikte saklanacak ek bilgi (ör. answeredThrough). */
    meta?: Record<string, unknown>;
  },
): Promise<DeliveryResult> {
  const [stored] = await deps.db
    .insert(messages)
    .values({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      sender: opts.sender,
      text: opts.text,
      authorUserId: opts.authorUserId ?? null,
      meta: opts.meta ?? null,
    })
    .returning({ id: messages.id });
  const messageId = stored!.id;
  let result: DeliveryResult;
  try {
    const ids = await deps.wa.sendText({ ...opts.wa, text: opts.text });
    await deps.db
      .update(messages)
      .set({ waMessageId: ids[0] ?? null, meta: { ...opts.meta, waMessageIds: ids } })
      .where(eq(messages.id, messageId));
    result = { messageId, sent: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.log.error(`WhatsApp mesajı gönderilemedi (tenant=${opts.tenantId})`, err);
    await deps.db.update(messages).set({ meta: { ...opts.meta, sendError: error } }).where(eq(messages.id, messageId));
    result = { messageId, sent: false, error };
  }
  deps.events?.publish(opts.tenantId, { type: "message", conversationId: opts.conversationId });
  return result;
}

/** Konuşmanın WhatsApp hedefi: hangi numaradan, hangi müşteriye (token çözülmüş). */
export async function waTargetFor(db: DB, masterKey: string, conversationId: string): Promise<WaTarget> {
  const [row] = await db
    .select({ account: whatsappAccounts, waId: customers.waId, chatRef: customers.channelRef })
    .from(conversations)
    .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, conversations.whatsappAccountId))
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .where(eq(conversations.id, conversationId));
  if (!row) throw new Error("Konuşma bulunamadı");
  return {
    phoneNumberId: row.account.phoneNumberId,
    accessToken: decryptSecret(row.account.accessTokenEnc, masterKey),
    to: row.waId,
    chatRef: row.chatRef ?? undefined,
  };
}
