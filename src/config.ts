import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  /** Varsa gerçek Postgres; yoksa PGLITE_DIR'deki gömülü veritabanı kullanılır. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default("./data/pglite"),
  /** Mağaza token'larını şifrelemek için 32 baytlık anahtar (base64). */
  MASTER_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
    message: "MASTER_KEY 32 baytlık base64 olmalı: node -e \"console.log(crypto.randomBytes(32).toString('base64'))\"",
  }),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-sonnet-5"),
  /** Müşteri kartını güncelleyen model: her cevaptan sonra arka planda çalışır, hızlı ve ucuz olmalı. */
  CLAUDE_MEMORY_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  /** Sesli mesajları yazıya çeviren Groq (Whisper) anahtarı; boşsa sesli mesajlara "yazarak iletin" denir. */
  GROQ_API_KEY: z.string().optional(),
  STT_MODEL: z.string().default("whisper-large-v3-turbo"),
  /**
   * Meta WhatsApp: uygulamanın gizli anahtarı ve webhook'ta girilen doğrulama metni. İkisi de
   * girilene kadar WhatsApp webhook'u kapalıdır (panel, Shopify ve arşiv yine çalışır).
   */
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  GRAPH_API_VERSION: z.string().default("v23.0"),
  /** Konuşma geçmişinden Claude'a gönderilecek son mesaj sayısı. */
  HISTORY_LIMIT: z.coerce.number().default(20),
  TZ: z.string().default("Europe/Istanbul"),
  /** Sunucunun dışarıdan erişilen adresi (ör. ngrok / Railway), Shopify yönlendirmesi için. */
  APP_URL: z.string().url().optional(),
  // Shopify Dev Dashboard'daki uygulamanın bilgileri. Boşsa Shopify kurulumu kapalıdır.
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default("2026-07"),
  /** Mağaza bilgilerinin kontrol aralığı (dakika). */
  KNOWLEDGE_SYNC_MINUTES: z.coerce.number().default(15),
  /** Kampanya arşivinin (ürün ve site yazıları) kontrol aralığı (dakika). */
  ARCHIVE_SYNC_MINUTES: z.coerce.number().default(15),
});

export type Config = z.infer<typeof schema>;

/**
 * Ortam değişkenlerini okur. `server`: sunucunun kendisi için ek şartlar (komut satırı araçları
 * bunlar olmadan da çalışır). Eksiklerin hepsi tek seferde listelenir.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { server?: boolean } = {}): Config {
  // .env.example'daki gibi boş bırakılan satırlar (APP_URL=) "tanımlı değil" sayılır.
  const filled = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(filled);
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
  if (opts.server) {
    if (!filled.ANTHROPIC_API_KEY) problems.push("  - ANTHROPIC_API_KEY: Lina'nın Claude anahtarı gerekli (console.anthropic.com → API Keys)");
    // Railway'de dosya sistemi her yayında sıfırlanır: gömülü veritabanıyla bütün kayıtlar silinirdi.
    if (isRailway(filled) && !filled.DATABASE_URL) {
      problems.push("  - DATABASE_URL: Railway'de Postgres gerekli (projeye Postgres ekleyip değişkeni bu servise bağlayın)");
    }
  }
  if (problems.length) {
    const where = isRailway(filled) ? "Railway → servis → Variables" : ".env dosyası";
    throw new Error(`Eksik ya da hatalı ortam değişkenleri (${where}):\n${problems.join("\n")}`);
  }
  return parsed.data!;
}

const isRailway = (env: Record<string, string | undefined>) => Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);

/** WhatsApp webhook'u için iki değer de girilmiş mi? */
export const whatsappConfigured = (c: Pick<Config, "WHATSAPP_APP_SECRET" | "WHATSAPP_VERIFY_TOKEN">) =>
  Boolean(c.WHATSAPP_APP_SECRET && c.WHATSAPP_VERIFY_TOKEN);
