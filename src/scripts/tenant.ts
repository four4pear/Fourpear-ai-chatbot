/**
 * Panel gelene kadar mağaza yönetimi için komut satırı aracı.
 *
 *   npm run tenant -- upsert --slug maius --name MAIUS --domain maiusonline.com \
 *     --hours "1,2,3,4,5,6 10:00-17:00" [--notes "Bu hafta kargoda gecikme var"]
 *   npm run tenant -- whatsapp --slug maius --phone-number-id 123 --token EAAG...
 *   npm run tenant -- shopify-app --slug maius --shop maius.myshopify.com --client-id abc123
 *        (mağazaya özel Shopify uygulaması; Client secret gizli sorulur)
 *   npm run tenant -- shopify-link --slug maius --shop maius.myshopify.com
 *   npm run tenant -- sync --slug maius          (Shopify'dan bilgileri şimdi yenile)
 *   npm run tenant -- docs --slug maius          (Lina'nın kullandığı kaynaklar)
 *   npm run tenant -- doc --slug maius --id 3f2a --off | --on | --auto
 *   npm run tenant -- alerts --slug maius        (bilgi çelişkisi uyarıları)
 *   npm run tenant -- list
 *   npm run tenant -- admin --email sen@ornek.com --name "Ad Soyad"   (yönetici + şifre linki)
 *   npm run tenant -- invite --slug maius --email sahip@maius.info --role owner   (davet linki)
 *
 * İade:
 *   npm run tenant -- upsert --slug maius --returns-url https://iade.betulsaday.com   (Lina'nın vereceği iade formu)
 *   npm run tenant -- upsert --slug maius --phone-country 90   (Shopify'da ülke kodsuz yazılan telefonların ülkesi)
 *   npm run tenant -- returns --slug maius --url https://iade.betulsaday.com/mcp.php --store maius
 *        (iade sistemi bağlantısı; anahtar gizli sorulur, bağlantı test edilir)
 *   npm run tenant -- returns --slug maius --test | --off
 *
 * Kampanya arşivi (ürün ve site yazılarının tarihli kopyaları):
 *   npm run tenant -- archive --slug maius       (vitrinden şimdi güncelle)
 *   npm run tenant -- archive-import --slug maius --products urunler.json [--home anasayfa.html] [--at 2026-09-28T13:51:00+03:00]
 *   npm run tenant -- archive-show --slug maius [--title "Lavin Etek"]
 *
 * Günler: 0=pazar ... 6=cumartesi
 */
import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { exitIfLocked, openDatabase } from "../db/client.js";
import {
  integrations,
  knowledgeAlerts,
  knowledgeDocs,
  users,
  resolveSettings,
  shopifyStores,
  tenants,
  whatsappAccounts,
  type BusinessHours,
} from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { promptSecret } from "../lib/prompt.js";
import { ALLOWED_TOOLS, DANGEROUS_TOOLS, McpClient } from "../returns/kolay-iade.js";
import { createInvite, createResetToken, normalizeEmail } from "../auth/service.js";
import { isEnabled } from "../knowledge/base.js";
import { syncStoreKnowledge } from "../knowledge/sync.js";
import { oauthSigningKey, shopifyApps } from "../shopify/apps.js";
import { createShopifyApi } from "../shopify/client.js";
import { createInstallToken, isValidShopDomain } from "../shopify/oauth.js";
import { currentTexts, recordSnapshot, refreshCampaignDoc, versionsByTitle, type RecordResult } from "../archive/archive.js";
import { parseProductsJson, productSnapshot, siteTextsOf } from "../archive/storefront.js";
import { archiveTenant, describeRun } from "../archive/sync.js";

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
    "client-id": { type: "string" },
    id: { type: "string" },
    email: { type: "string" },
    role: { type: "string" },
    on: { type: "boolean" },
    off: { type: "boolean" },
    auto: { type: "boolean" },
    products: { type: "string", multiple: true },
    home: { type: "string" },
    at: { type: "string" },
    title: { type: "string" },
    "returns-url": { type: "string" },
    "phone-country": { type: "string" },
    url: { type: "string" },
    store: { type: "string" },
    test: { type: "boolean" },
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

const formatDate = (d: Date) => d.toLocaleString("tr-TR", { timeZone: config.TZ, dateStyle: "short", timeStyle: "short" });
const formatRecord = (r: RecordResult) => `${r.added} yeni, ${r.changed} değişen, ${r.unchanged} aynı, ${r.ended} kalkan`;

/** Kopyanın tarihi: --at verilmediyse dosyanın kaydedildiği an. */
async function snapshotTime(file: string): Promise<Date> {
  if (!args.at) return (await stat(file)).mtime;
  const at = new Date(args.at);
  if (Number.isNaN(at.getTime())) throw new Error("--at geçerli bir tarih olmalı, ör. 2026-09-28T13:51:00+03:00");
  return at;
}

/** İade sistemi bağlantı testi: anahtar hangi araçları görebiliyor? */
async function testReturnsConnection(url: string, key: string) {
  const tools = await new McpClient({ url, key }).listTools();
  console.log(`Bağlantı tamam. Anahtarın görebildiği araç sayısı: ${tools.length}`);
  const missing = ALLOWED_TOOLS.filter((t) => !tools.includes(t));
  if (missing.length) console.log(`⚠️ Lina'nın kullandığı araçlar görünmüyor: ${missing.join(", ")}`);
  const risky = tools.filter((t) => DANGEROUS_TOOLS.includes(t));
  if (risky.length) {
    console.log(
      `⚠️ Bu anahtar yazma/yönetim araçlarını da görebiliyor (${risky.join(", ")}). Lina bunları asla çağırmaz, ` +
        "ama anahtar çalınırsa diye panelden yalnızca talep_ara ve talep_detay ile kısıtlanması önerilir.",
    );
  }
}

const apps = shopifyApps(
  db,
  config.MASTER_KEY,
  config.SHOPIFY_API_KEY && config.SHOPIFY_API_SECRET ? { apiKey: config.SHOPIFY_API_KEY, apiSecret: config.SHOPIFY_API_SECRET } : undefined,
);

function shopArg(): string {
  const shop = required("shop").toLowerCase();
  if (!isValidShopDomain(shop)) throw new Error("--shop magaza-adi.myshopify.com biçiminde olmalı");
  return shop;
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
    const returnsUrl = args["returns-url"];
    if (returnsUrl && !/^https:\/\/\S+$/.test(returnsUrl)) throw new Error("--returns-url https:// ile başlamalı");
    const phoneCountry = args["phone-country"];
    if (phoneCountry !== undefined && !/^\d{1,3}$/.test(phoneCountry)) throw new Error("--phone-country ülke kodu olmalı, ör. 90");
    const settingsChange = {
      ...(args.hours && { businessHours: parseHours(args.hours) }),
      ...(returnsUrl !== undefined && { returnsFormUrl: returnsUrl }),
      ...(phoneCountry !== undefined && { phoneCountryCode: phoneCountry }),
    };
    const fields = {
      ...(args.name && { name: args.name }),
      ...(args.domain && { domain: args.domain }),
      ...(args["bot-name"] && { botName: args["bot-name"] }),
      ...(args.notes !== undefined && { notes: args.notes }),
      ...(Object.keys(settingsChange).length && { settings: { ...resolveSettings(existing?.settings), ...settingsChange } }),
    };
    const [tenant] = await db
      .insert(tenants)
      .values({ slug, name: args.name ?? slug, ...fields })
      .onConflictDoUpdate({ target: tenants.slug, set: Object.keys(fields).length ? fields : { slug } })
      .returning();
    const settings = resolveSettings(tenant!.settings);
    const hours = settings.businessHours;
    console.log(
      `Mağaza kaydedildi: ${tenant!.name} (${tenant!.slug}), mesai ${hours.days.join(",")} ${hours.start}-${hours.end}, ` +
        `notlar ${tenant!.notes.length} karakter, iade formu ${settings.returnsFormUrl || "yok"}`,
    );
  } else if (command === "returns") {
    // İade sistemi bağlantısı (yalnızca okuma). Anahtar gizli sorulur; komut satırında dolaşmaz.
    const tenant = await tenantBySlug();
    const where = and(eq(integrations.tenantId, tenant.id), eq(integrations.kind, "returns_mcp"));
    const [existing] = await db.select().from(integrations).where(where);
    if (args.off) {
      if (!existing) throw new Error("Bu mağazada iade sistemi bağlantısı yok");
      await db.update(integrations).set({ enabled: false, updatedAt: new Date() }).where(where);
      console.log("İade sistemi bağlantısı kapatıldı; Lina iade durumunu artık okumaz.");
    } else if (args.test) {
      if (!existing?.secretEnc) throw new Error("Bu mağazada iade sistemi bağlantısı yok");
      await testReturnsConnection(existing.config.url!, decryptSecret(existing.secretEnc, config.MASTER_KEY));
    } else {
      const url = required("url");
      const store = required("store");
      if (!/^https:\/\/\S+$/.test(url)) throw new Error("--url https:// ile başlamalı");
      const key = await promptSecret("İade sistemi anahtarı (yazdığınız görünmez, sonra Enter): ");
      if (!key) throw new Error("Anahtar boş olamaz");
      await testReturnsConnection(url, key);
      const values = {
        tenantId: tenant.id,
        kind: "returns_mcp" as const,
        config: { url, store },
        secretEnc: encryptSecret(key, config.MASTER_KEY),
        enabled: true,
        updatedAt: new Date(),
      };
      await db
        .insert(integrations)
        .values(values)
        .onConflictDoUpdate({ target: [integrations.tenantId, integrations.kind], set: values });
      console.log(`İade sistemi ${tenant.slug} mağazasına bağlandı (mağaza kodu: ${store}). Anahtar şifreli saklandı.`);
    }
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
  } else if (command === "shopify-app") {
    // Mağazaya özel Shopify uygulaması (özel dağıtım). Client secret gizli sorulur; komut satırında dolaşmaz.
    const tenant = await tenantBySlug();
    const where = and(eq(integrations.tenantId, tenant.id), eq(integrations.kind, "shopify_app"));
    if (args.off) {
      const off = await db.update(integrations).set({ enabled: false, updatedAt: new Date() }).where(where).returning();
      if (!off.length) throw new Error("Bu mağazanın kendi Shopify uygulaması yok");
      console.log("Mağazanın kendi Shopify uygulaması kapatıldı; varsa ortak uygulama kullanılır.");
    } else {
      const shop = shopArg();
      const clientId = required("client-id");
      const secret = await promptSecret("Shopify Client secret (yazdığınız görünmez, sonra Enter): ");
      if (!secret) throw new Error("Client secret boş olamaz");
      const values = {
        tenantId: tenant.id,
        kind: "shopify_app" as const,
        config: { clientId, shop },
        secretEnc: encryptSecret(secret, config.MASTER_KEY),
        enabled: true,
        updatedAt: new Date(),
      };
      await db
        .insert(integrations)
        .values(values)
        .onConflictDoUpdate({ target: [integrations.tenantId, integrations.kind], set: values });
      console.log(`${tenant.slug} mağazasının Shopify uygulaması kaydedildi (${shop}). Client secret şifreli saklandı.`);
    }
  } else if (command === "shopify-link") {
    const tenant = await tenantBySlug();
    const shop = shopArg();
    if (!config.APP_URL) throw new Error("APP_URL tanımlı olmalı (sunucunun herkese açık adresi)");
    if (!(await apps.forTenant(tenant.id))) {
      throw new Error("Bu mağazanın Shopify uygulaması yok: önce 'shopify-app' ile girin (ya da ortak SHOPIFY_API_KEY/SECRET)");
    }
    const url = new URL("/shopify/install", config.APP_URL);
    url.search = new URLSearchParams({ token: createInstallToken(tenant.id, shop, oauthSigningKey(config.MASTER_KEY)) }).toString();
    console.log(`Mağaza sahibinin açması gereken kurulum linki (24 saat geçerli, sadece ${shop} için):\n${url}`);
  } else if (command === "sync") {
    const tenant = await tenantBySlug();
    const [store] = await db.select().from(shopifyStores).where(eq(shopifyStores.tenantId, tenant.id));
    if (!store) throw new Error("Bu mağazada Shopify uygulaması kurulu değil; 'shopify-link' ile kurun");
    const shopify = createShopifyApi({
      db,
      masterKey: config.MASTER_KEY,
      appFor: apps.forTenant,
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
  } else if (command === "archive") {
    // Sunucu açıkken arşiv kendiliğinden güncellenir; kapalıyken bu komutla.
    const run = await archiveTenant(db, await tenantBySlug());
    console.log(`Arşiv güncellendi. ${describeRun(run)}`);
    for (const e of run.errors) console.error(`Hata: ${e}`);
  } else if (command === "archive-import") {
    const tenant = await tenantBySlug();
    if (!args.products?.length && !args.home) throw new Error("--products <dosya> ve/veya --home <dosya> belirtin");
    if (args.products?.length) {
      const items = [];
      for (const file of args.products) items.push(...parseProductsJson(await readFile(file, "utf8")).map(productSnapshot));
      const seenAt = await snapshotTime(args.products[0]!);
      const r = await recordSnapshot(db, tenant.id, "product", items, seenAt);
      console.log(`Ürünler (${formatDate(seenAt)}): ${formatRecord(r)}`);
    }
    if (args.home) {
      const seenAt = await snapshotTime(args.home);
      const site = siteTextsOf(await readFile(args.home, "utf8"));
      const r = await recordSnapshot(db, tenant.id, "site", site.items, seenAt, { allowEmpty: site.authoritative });
      console.log(`Site yazıları (${formatDate(seenAt)}): ${formatRecord(r)}`);
    }
    await refreshCampaignDoc(db, tenant.id);
  } else if (command === "archive-show") {
    const tenant = await tenantBySlug();
    if (args.title) {
      const versions = await versionsByTitle(db, tenant.id, "product", args.title);
      if (!versions.length) console.log("Arşivde bu başlıkla ürün yok");
      for (const v of versions) {
        const until = v.endedAt ? formatDate(v.endedAt) : "güncel";
        console.log(`\n${v.title}: ${formatDate(v.firstSeenAt)} → ${until} (son görülme ${formatDate(v.lastSeenAt)})`);
        console.log(`  ${v.content.replace(/\s+/g, " ").slice(0, 400)}`);
      }
    } else {
      const products = await currentTexts(db, tenant.id, "product");
      const site = await currentTexts(db, tenant.id, "site");
      console.log(`Arşivde güncel ${products.length} ürün ve ${site.length} site yazısı var.`);
      for (const s of site) console.log(`- ${s.title}: ${s.content.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  } else if (command === "list") {
    const rows = await db
      .select({
        slug: tenants.slug,
        name: tenants.name,
        whatsapp: whatsappAccounts.phoneNumberId,
        shopify: shopifyStores.shopDomain,
        shopifyApp: integrations.config,
        shopifyAppOn: integrations.enabled,
        lastSync: shopifyStores.lastSyncAt,
        syncError: shopifyStores.lastSyncError,
      })
      .from(tenants)
      .leftJoin(whatsappAccounts, eq(whatsappAccounts.tenantId, tenants.id))
      .leftJoin(shopifyStores, eq(shopifyStores.tenantId, tenants.id))
      .leftJoin(integrations, and(eq(integrations.tenantId, tenants.id), eq(integrations.kind, "shopify_app")));
    console.table(
      rows.map(({ shopifyApp, shopifyAppOn, ...r }) => ({
        ...r,
        // Mağazanın kendi uygulaması mı, sunucudaki ortak uygulama mı?
        shopifyApp: shopifyApp && shopifyAppOn ? `kendi (${shopifyApp.shop})` : apps.shared ? "ortak" : "yok",
      })),
    );
  } else {
    console.log(
      "Komutlar: upsert | whatsapp | shopify-link | sync | docs | doc | alerts | admin | invite | list | returns | archive | archive-import | archive-show  (ayrıntı: src/scripts/tenant.ts)",
    );
  }
} finally {
  await close();
}
