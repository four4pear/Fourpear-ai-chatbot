import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/** Mağazanın panelden değiştirebildiği sabit metinlerin anahtarları. */
export type FixedTextKey = "unsupported" | "dailyLimit" | "failure";

export type BusinessHours = {
  /** Açık günler, 0 = pazar ... 6 = cumartesi */
  days: number[];
  /** "10:00" biçiminde, mağazanın saat diliminde */
  start: string;
  end: string;
};

export type TenantSettings = {
  botEnabled: boolean;
  dailyMessageLimit: number;
  businessHours: BusinessHours;
  /** Varsayılan sabit metinlerin yerine geçen mağaza metinleri. */
  texts: Partial<Record<FixedTextKey, string>>;
  /** Web arama aracının erişebileceği alan adları (Faz 4). */
  allowedSearchDomains: string[];
  /**
   * Art arda mesajlar: müşterinin son mesajından sonra bu kadar beklenir, gelen mesajlar
   * tek cevapta birleştirilir (docs/lina-davranis.md "Art arda mesajlar").
   */
  replyDelaySeconds: number;
  /** Durmadan yazan müşteri için üst sınır: ilk cevapsız mesajdan en fazla bu kadar sonra cevap. */
  maxReplyWaitSeconds: number;
  /** Müşterinin iade/değişim talebini kendisi açtığı form (ör. Kolay İade); boşsa yok. */
  returnsFormUrl: string;
  /**
   * Shopify'da ülke kodu olmadan yazılmış telefonların ülkesi (ör. "0532…" → 90). Sipariş sahipliği
   * doğrulanırken kullanılır; yanlışsa başka ülkeden bir numara yanlış kişiyle eşleşebilir.
   */
  phoneCountryCode: string;
};

export const defaultTenantSettings: TenantSettings = {
  botEnabled: true,
  dailyMessageLimit: 200,
  businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
  texts: {},
  allowedSearchDomains: [],
  replyDelaySeconds: 30,
  maxReplyWaitSeconds: 180,
  returnsFormUrl: "",
  phoneCountryCode: "90",
};

/** Eski kayıtlarda eksik olabilecek alanları varsayılanlarla tamamlar. */
export function resolveSettings(settings: Partial<TenantSettings> | null | undefined): TenantSettings {
  return { ...defaultTenantSettings, ...settings, texts: { ...settings?.texts } };
}

// node-postgres Buffer, PGlite Uint8Array döndürür; uygulama her zaman Buffer görür.
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => Buffer.from(value),
});

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  botName: text("bot_name").notNull().default("Lina"),
  /** Mağazanın web adresi, ör. maiusonline.com */
  domain: text("domain"),
  /** "Lina'ya notlar": sitede olmayan geçici bilgiler; siteyle çelişirse bunlar geçerlidir. */
  notes: text("notes").notNull().default(""),
  settings: jsonb("settings").$type<Partial<TenantSettings>>().notNull().default(defaultTenantSettings),
  plan: text("plan").notNull().default("pilot"),
  createdAt: createdAt(),
});

export const whatsappAccounts = pgTable("whatsapp_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  phoneNumberId: text("phone_number_id").notNull().unique(),
  displayPhone: text("display_phone"),
  /** AES-256-GCM ile şifrelenmiş erişim token'ı (bkz. lib/crypto.ts). */
  accessTokenEnc: text("access_token_enc").notNull(),
  createdAt: createdAt(),
});

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    /** WhatsApp numarası (sadece rakam, ülke koduyla), ör. 905321234567 */
    waId: text("wa_id").notNull(),
    name: text("name"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("customers_tenant_wa_idx").on(t.tenantId, t.waId)],
);

/**
 * bot: Lina cevaplıyor
 * waiting: devredildi, ekip henüz devralmadı; Lina basit sorulara cevap vermeye devam eder
 * human: ekipten biri devraldı; Lina susar
 */
export type ConversationStatus = "bot" | "waiting" | "human";

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    whatsappAccountId: uuid("whatsapp_account_id").notNull().references(() => whatsappAccounts.id),
    status: text("status").$type<ConversationStatus>().notNull().default("bot"),
    /** Konuşmayı devralan ekip üyesi (status "human" iken). */
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    lastCustomerMessageAt: timestamp("last_customer_message_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversations_customer_idx").on(t.customerId),
    index("conversations_tenant_updated_idx").on(t.tenantId, t.updatedAt),
  ],
);

export type MessageSender = "customer" | "bot" | "agent" | "system";

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    sender: text("sender").$type<MessageSender>().notNull(),
    /**
     * WhatsApp mesaj tipi: text, image, audio, ...
     * "note": panelde görünen iç not (devraldı, bota geri verdi); müşteriye gitmez.
     */
    type: text("type").notNull().default("text"),
    /** sender "agent" ise mesajı yazan ekip üyesi. */
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    text: text("text"),
    /** WhatsApp mesaj kimliği; gelen mesajlarda tekrar işlemeyi önler. */
    waMessageId: text("wa_message_id").unique(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    /** lina, knowledge, order, product */
    agent: text("agent").notNull(),
    model: text("model").notNull(),
    input: text("input"),
    output: text("output"),
    stopReason: text("stop_reason"),
    apiCalls: integer("api_calls").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_runs_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const handoffs = pgTable(
  "handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    summary: text("summary").notNull(),
    status: text("status").$type<"open" | "resolved">().notNull().default("open"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("handoffs_tenant_status_idx").on(t.tenantId, t.status)],
);

/** Mağazanın Shopify bağlantısı (OAuth ile kurulur, token'lar şifreli). */
export const shopifyStores = pgTable("shopify_stores", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }).unique(),
  shopDomain: text("shop_domain").notNull().unique(),
  scopes: text("scopes").notNull(),
  accessTokenEnc: text("access_token_enc").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenEnc: text("refresh_token_enc"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  /** Uygulama kaldırıldıysa dolu; bilgiler artık güncellenmez. */
  uninstalledAt: timestamp("uninstalled_at", { withTimezone: true }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastSyncError: text("last_sync_error"),
});

/**
 * core: her soruda bilgi uzmanına verilir (kargo, iade, SSS...)
 * legal: uzun hukuki metinler; sadece gerektiğinde araçla okunur
 */
export type KnowledgeKind = "core" | "legal";

/** Shopify'dan çekilen mağaza bilgileri (politikalar, sayfalar, mağaza künyesi). */
export const knowledgeDocs = pgTable(
  "knowledge_docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    /** policy | page | shop */
    source: text("source").notNull(),
    /** Shopify kimliği (politika için tipi, ör. REFUND_POLICY) */
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    content: text("content").notNull(),
    kind: text("kind").$type<KnowledgeKind>().notNull(),
    /** Otomatik seçim: boş/form sayfaları false. */
    autoEnabled: boolean("auto_enabled").notNull(),
    /** Mağazanın panelden yaptığı seçim; null ise otomatik seçim geçerli. */
    enabledOverride: boolean("enabled_override"),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("knowledge_docs_source_idx").on(t.tenantId, t.source, t.externalId)],
);

/** Bilgi uzmanının bulduğu çelişkiler; panelde mağazaya uyarı olarak gösterilir. */
export const knowledgeAlerts = pgTable(
  "knowledge_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    topic: text("topic").notNull(),
    description: text("description").notNull(),
    status: text("status").$type<"open" | "resolved">().notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [index("knowledge_alerts_tenant_idx").on(t.tenantId, t.status)],
);

/**
 * product: bir ürünün açıklaması, etiketleri ve fiyatları (ref = Shopify ürün kimliği)
 * site: sitenin görünen kampanya yazıları, ör. üst bant ya da ana sayfa afişi (ref = tema bölümü)
 */
export type ArchiveKind = "product" | "site";

export type ArchivedVariant = { id: string; title: string; price: string; compareAtPrice: string | null };

export type ArchiveData = {
  handle?: string;
  tags?: string[];
  variants?: ArchivedVariant[];
  /** site: tema bölümünün türü, ör. announcement-bar, countdown */
  section?: string;
};

/**
 * Kampanya arşivi (docs/lina-davranis.md "Kampanya yazıları"): ürün ve site yazılarının tarihli
 * sürümleri. Yazı değişince eskisi silinmez, bitiş tarihiyle kalır; siparişle ilgili cevaplarda
 * sipariş tarihindeki sürüm kullanılır.
 */
export const textArchive = pgTable(
  "text_archive",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ArchiveKind>().notNull(),
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    data: jsonb("data").$type<ArchiveData>().notNull().default({}),
    /** Başlık, yazı ve verinin özeti; aynıysa yeni sürüm açılmaz. */
    hash: text("hash").notNull(),
    /** Bu sürümün ilk ve son görüldüğü an. */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /** Yazı değiştiğinde ya da ürün/bölüm kalktığında dolar; boşsa güncel sürüm. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("text_archive_ref_idx").on(t.tenantId, t.kind, t.ref, t.firstSeenAt),
    uniqueIndex("text_archive_current_idx").on(t.tenantId, t.kind, t.ref).where(sql`${t.endedAt} is null`),
  ],
);

/**
 * Sipariş konularında ekibe bildirim (docs/lina-davranis.md "Ekibe bildirimler"). Bu konularda
 * konuşma devredilmez; her sipariş sorusu kaydedilir, önemliler panelde sesli uyarıyla gelir.
 */
/** lookup_failed: sipariş sistemine ulaşılamadı (ör. Shopify hatası); müşterinin isteği ekibe kalır. */
export const IMPORTANT_KINDS = ["complaint", "cancel_request", "change_request", "lookup_failed", "delay", "no_tracking"] as const;
export const RECORD_KINDS = ["return_request", "return_status", "unverified", "order_question"] as const;
/** Önem sırasıyla: bir cevapta birden fazla konu varsa bildirimin türü ilk sıradaki olur. */
export const NOTIFICATION_KINDS = [...IMPORTANT_KINDS, ...RECORD_KINDS] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationDetails = {
  /** Bu cevaptaki bütün bildirim türleri (önem sırasıyla). */
  kinds?: NotificationKind[];
  /** Ekip için kısa açıklamalar, ör. "Gecikme: Lavin Etek (Siyah), planlanan 25 Eylül 2026". */
  issues?: string[];
  /** Lina'nın cevabı WhatsApp'a gönderilemedi: müşteri cevapsız kaldı. */
  replyFailed?: boolean;
};

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NotificationKind>().notNull(),
    /** Önemli bildirim: panelde sesli uyarı ve tarayıcı bildirimi. */
    important: boolean("important").notNull(),
    orderNames: jsonb("order_names").$type<string[]>().notNull().default([]),
    /** Müşterinin yazdıkları ve Lina'nın cevabı (ekip için). */
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    details: jsonb("details").$type<NotificationDetails>().notNull().default({}),
    status: text("status").$type<"open" | "done">().notNull().default("open"),
    createdAt: createdAt(),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneBy: uuid("done_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("notifications_tenant_idx").on(t.tenantId, t.status, t.createdAt)],
);

/**
 * returns_mcp: mağazanın iade sistemi (ör. Kolay İade paneli), MCP üzerinden yalnızca okuma.
 * shopify_app: mağazaya özel Shopify uygulaması, config { clientId, shop }, secretEnc = Client secret (bkz. shopify/apps.ts).
 */
export type IntegrationKind = "returns_mcp" | "shopify_app";

/** Mağazanın dış sistem bağlantıları. Anahtar şifreli saklanır (bkz. lib/crypto.ts). */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IntegrationKind>().notNull(),
    /** Gizli olmayan ayarlar, ör. { url, store } */
    config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
    secretEnc: text("secret_enc"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("integrations_tenant_kind_idx").on(t.tenantId, t.kind)],
);

/** Müşterinin gönderdiği fotoğraflar (ekip panelde görür, Lina okur). */
export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }).unique(),
  waMediaId: text("wa_media_id").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  data: bytea("data").notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Panel hesapları

/** Panel kullanıcısı. Bir kişi birden fazla mağazada olabilir (memberships). */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Küçük harfe çevrilmiş e-posta */
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** scrypt özeti (bkz. auth/password.ts); şifre hiç belirlenmediyse null */
  passwordHash: text("password_hash"),
  /** Platform yöneticisi: tüm mağazaları görür. */
  isSuperAdmin: boolean("is_super_admin").notNull().default(false),
  createdAt: createdAt(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

/** owner: mağaza sahibi (ayarlar, istatistik, ekip) · agent: çalışan (sadece sohbetler) */
export type MemberRole = "owner" | "agent";

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_user_tenant_idx").on(t.userId, t.tenantId)],
);

/** Giriş oturumları. Çerezdeki anahtarın kendisi değil, SHA-256 özeti saklanır. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Tek kullanımlık linkler. invite: mağazaya katılma (7 gün) · reset: şifre belirleme (24 saat).
 * Linkteki anahtarın yalnızca özeti saklanır.
 */
export const authTokens = pgTable("auth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<"invite" | "reset">().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  /** invite: katılınacak mağaza ve rol */
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  role: text("role").$type<MemberRole>(),
  /** reset: şifresi belirlenecek kullanıcı */
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Tenant = typeof tenants.$inferSelect;
export type WhatsappAccount = typeof whatsappAccounts.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ShopifyStore = typeof shopifyStores.$inferSelect;
export type KnowledgeDoc = typeof knowledgeDocs.$inferSelect;
export type ArchivedText = typeof textArchive.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
