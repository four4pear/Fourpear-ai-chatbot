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
  CLAUDE_MODEL: z.string().default("claude-sonnet-5"),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // .env.example'daki gibi boş bırakılan satırlar (APP_URL=) "tanımlı değil" sayılır.
  const filled = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(filled);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Eksik ya da hatalı ortam değişkenleri (.env):\n${problems}`);
  }
  return parsed.data;
}
