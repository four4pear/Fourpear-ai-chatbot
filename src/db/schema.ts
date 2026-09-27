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
};

export const defaultTenantSettings: TenantSettings = {
  botEnabled: true,
  dailyMessageLimit: 200,
  businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
  texts: {},
  allowedSearchDomains: [],
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
    lastCustomerMessageAt: timestamp("last_customer_message_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("conversations_customer_idx").on(t.customerId)],
);

export type MessageSender = "customer" | "bot" | "agent" | "system";

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    sender: text("sender").$type<MessageSender>().notNull(),
    /** WhatsApp mesaj tipi: text, image, audio, ... */
    type: text("type").notNull().default("text"),
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

export type Tenant = typeof tenants.$inferSelect;
export type WhatsappAccount = typeof whatsappAccounts.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ShopifyStore = typeof shopifyStores.$inferSelect;
export type KnowledgeDoc = typeof knowledgeDocs.$inferSelect;
