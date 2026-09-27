/**
 * Panel gelene kadar mağaza yönetimi için komut satırı aracı.
 *
 *   npm run tenant -- upsert --slug maius --name MAIUS --domain maiusonline.com \
 *     --hours "1,2,3,4,5,6 10:00-17:00" [--notes "Bu hafta kargoda gecikme var"]
 *   npm run tenant -- whatsapp --slug maius --phone-number-id 123 --token EAAG...
 *   npm run tenant -- shopify-link --slug maius --shop maius.myshopify.com
 *   npm run tenant -- sync --slug maius          (Shopify'dan bilgileri şimdi yenile)
 *   npm run tenant -- docs --slug maius          (Lina'nın kullandığı kaynaklar)
 *   npm run tenant -- doc --slug maius --id 3f2a --off | --on | --auto
 *   npm run tenant -- alerts --slug maius        (bilgi çelişkisi uyarıları)
 *   npm run tenant -- list
 *   npm run tenant -- admin --email sen@ornek.com --name "Ad Soyad"   (yönetici + şifre linki)
 *   npm run tenant -- invite --slug maius --email sahip@maius.info --role owner   (davet linki)
 *
 * Günler: 0=pazar ... 6=cumartesi
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { exitIfLocked, openDatabase } from "../db/client.js";
import {
  knowledgeAlerts,
  knowledgeDocs,
  users,
  resolveSettings,
  shopifyStores,
  tenants,
  whatsappAccounts,
  type BusinessHours,
} from "../db/schema.js";
import { encryptSecret } from "../lib/crypto.js";
import { createInvite, createResetToken, normalizeEmail } from "../auth/service.js";
import { isEnabled } from "../knowledge/base.js";
import { syncStoreKnowledge } from "../knowledge/sync.js";
import { createShopifyApi } from "../shopify/client.js";
import { createInstallToken, isValidShopDomain } from "../shopify/oauth.js";

const [command, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: rest,
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    domain: { type: "string" },
    "bot-name": { type: "string" },
    notes: { type: "string" },
    hours: { type: "string" },
    "phone-number-id": { type: "string" },
    token: { type: "string" },
    "display-phone": { type: "string" },
    shop: { type: "string" },
    id: { type: "string" },
    email: { type: "string" },
    role: { type: "string" },
    on: { type: "boolean" },
    off: { type: "boolean" },
    auto: { type: "boolean" },
  },
});

const config = loadConfig();
const { db, close } = await openDatabase({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR }).catch(exitIfLocked);

function required(name: keyof typeof args): string {
  const v = args[name];
  if (typeof v !== "string" || !v) throw new Error(`--${name} gerekli`);
  return v;
}

const publicUrl = () => (config.APP_URL ?? `http://localhost:${config.PORT}`).replace(/\/$/, "");

function parseHours(value: string): BusinessHours {
  const match = /^([0-6](?:,[0-6])*)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(value.trim());
  if (!match) throw new Error('--hours biçimi: "1,2,3,4,5,6 10:00-17:00"');
  return { days: match[1]!.split(",").map(Number), start: match[2]!, end: match[3]! };
}

async function tenantBySlug() {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, required("slug")));
  if (!tenant) throw new Error("Mağaza bulunamadı; önce 'upsert' çalıştırın");
  return tenant;
}

try {
  if (command === "upsert") {
    const slug = required("slug");
    const [existing] = await db.select().from(tenants).where(eq(tenants.slug, slug));
    const fields = {
      ...(args.name && { name: args.name }),
      ...(args.domain && { domain: args.domain }),
      ...(args["bot-name"] && { botName: args["bot-name"] }),
      ...(args.notes !== undefined && { notes: args.notes }),
      ...(args.hours && {
        settings: { ...resolveSettings(existing?.settings), businessHours: parseHours(args.hours) },
      }),
    };
    const [tenant] = await db
      .insert(tenants)
      .values({ slug, name: args.name ?? slug, ...fields })
      .onConflictDoUpdate({ target: tenants.slug, set: Object.keys(fields).length ? fields : { slug } })
      .returning();
    const hours = resolveSettings(tenant!.settings).businessHours;
    console.log(
      `Mağaza kaydedildi: ${tenant!.name} (${tenant!.slug}), mesai ${hours.days.join(",")} ${hours.start}-${hours.end}, ` +
        `notlar ${tenant!.notes.length} karakter`,
    );
  } else if (command === "whatsapp") {
    const tenant = await tenantBySlug();
    const values = {
      tenantId: tenant.id,
      phoneNumberId: required("phone-number-id"),
      accessTokenEnc: encryptSecret(required("token"), config.MASTER_KEY),
      displayPhone: args["display-phone"] ?? null,
    };
    await db.insert(whatsappAccounts).values(values).onConflictDoUpdate({ target: whatsappAccounts.phoneNumberId, set: values });
    console.log(`WhatsApp numarası ${values.phoneNumberId} → ${tenant.slug} mağazasına bağlandı`);
  } else if (command === "shopify-link") {
    const tenant = await tenantBySlug();
    const shop = required("shop").toLowerCase();
    if (!isValidShopDomain(shop)) throw new Error("--shop magaza-adi.myshopify.com biçiminde olmalı");
    if (!config.APP_URL) throw new Error(".env içinde APP_URL tanımlı olmalı (ör. ngrok adresi)");
    if (!config.SHOPIFY_API_SECRET) throw new Error(".env içinde SHOPIFY_API_SECRET tanımlı olmalı");
    const url = new URL("/shopify/install", config.APP_URL);
    url.search = new URLSearchParams({ token: createInstallToken(tenant.id, shop, config.SHOPIFY_API_SECRET) }).toString();
    console.log(`Mağaza sahibinin açması gereken kurulum linki (24 saat geçerli, sadece ${shop} için):\n${url}`);
  } else if (command === "sync") {
    const tenant = await tenantBySlug();
    if (!config.SHOPIFY_API_KEY || !config.SHOPIFY_API_SECRET) throw new Error("SHOPIFY_API_KEY / SHOPIFY_API_SECRET eksik");
    const [store] = await db.select().from(shopifyStores).where(eq(shopifyStores.tenantId, tenant.id));
    if (!store) throw new Error("Bu mağazada Shopify uygulaması kurulu değil; 'shopify-link' ile kurun");
    const shopify = createShopifyApi({
      db,
      masterKey: config.MASTER_KEY,
      app: { apiKey: config.SHOPIFY_API_KEY, apiSecret: config.SHOPIFY_API_SECRET },
      apiVersion: config.SHOPIFY_API_VERSION,
    });
    const r = await syncStoreKnowledge(db, shopify, store);
    console.log(`Senkron tamam: ${r.total} kaynak, ${r.changed} değişen, ${r.removed} silinen`);
  } else if (command === "docs") {
    const tenant = await tenantBySlug();
    const docs = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, tenant.id));
    console.table(
      docs.map((d) => ({
        id: d.id.slice(0, 8),
        kullanım: !isEnabled(d) ? "kapalı" : d.kind === "core" ? "her soruda" : "gerekince",
        seçim: d.enabledOverride === null ? "otomatik" : "elle",
        tür: d.source,
        başlık: d.title,
        karakter: d.content.length,
      })),
    );
  } else if (command === "doc") {
    const tenant = await tenantBySlug();
    const override = args.on ? true : args.off ? false : args.auto ? null : undefined;
    if (override === undefined) throw new Error("--on, --off ya da --auto belirtin");
    const updated = await db
      .update(knowledgeDocs)
      .set({ enabledOverride: override })
      .where(and(eq(knowledgeDocs.tenantId, tenant.id), sql`${knowledgeDocs.id}::text like ${`${required("id")}%`}`))
      .returning({ title: knowledgeDocs.title });
    console.log(updated.length ? `Güncellendi: ${updated.map((d) => d.title).join(", ")}` : "Kaynak bulunamadı");
  } else if (command === "alerts") {
    const tenant = await tenantBySlug();
    const alerts = await db.select().from(knowledgeAlerts).where(eq(knowledgeAlerts.tenantId, tenant.id));
    console.table(alerts.map((a) => ({ durum: a.status, konu: a.topic, açıklama: a.description, tarih: a.createdAt })));
  } else if (command === "admin") {
    // Platform yöneticisi: tüm mağazaları görür. Şifre linkle belirlenir, komut satırında şifre dolaşmaz.
    const email = normalizeEmail(required("email"));
    const [user] = await db
      .insert(users)
      .values({ email, name: required("name"), isSuperAdmin: true })
      .onConflictDoUpdate({ target: users.email, set: { isSuperAdmin: true } })
      .returning();
    const token = await createResetToken(db, user!.id, null);
    console.log(`Yönetici hazır: ${email}\nŞifre belirleme linki (24 saat geçerli):\n${publicUrl()}/sifre/${token}`);
  } else if (command === "invite") {
    const tenant = await tenantBySlug();
    const role = args.role ?? "owner";
    if (role !== "owner" && role !== "agent") throw new Error("--role owner ya da agent olmalı");
    const token = await createInvite(db, { tenantId: tenant.id, email: required("email"), role, createdBy: null });
    console.log(`${tenant.name} için ${role === "owner" ? "sahip" : "çalışan"} daveti (7 gün geçerli):\n${publicUrl()}/davet/${token}`);
  } else if (command === "list") {
    const rows = await db
      .select({
        slug: tenants.slug,
        name: tenants.name,
        whatsapp: whatsappAccounts.phoneNumberId,
        shopify: shopifyStores.shopDomain,
        lastSync: shopifyStores.lastSyncAt,
        syncError: shopifyStores.lastSyncError,
      })
      .from(tenants)
      .leftJoin(whatsappAccounts, eq(whatsappAccounts.tenantId, tenants.id))
      .leftJoin(shopifyStores, eq(shopifyStores.tenantId, tenants.id));
    console.table(rows);
  } else {
    console.log("Komutlar: upsert | whatsapp | shopify-link | sync | docs | doc | alerts | admin | invite | list  (ayrıntı: src/scripts/tenant.ts)");
  }
} finally {
  await close();
}
