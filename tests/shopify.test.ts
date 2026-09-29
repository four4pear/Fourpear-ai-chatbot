import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { askKnowledgeAgent } from "../src/agents/knowledge.js";
import type { Llm } from "../src/agents/runner.js";
import { openDatabase, type Database } from "../src/db/client.js";
import { agentRuns, knowledgeAlerts, knowledgeDocs, shopifyStores, tenants, textArchive, type ShopifyStore } from "../src/db/schema.js";
import { recordSnapshot } from "../src/archive/archive.js";
import { decryptSecret, encryptSecret } from "../src/lib/crypto.js";
import { loadKnowledge, readLegalDoc } from "../src/knowledge/base.js";
import { htmlToText } from "../src/knowledge/html.js";
import { classifyPage, syncStoreKnowledge } from "../src/knowledge/sync.js";
import { createShopifyApi, type ShopifyApi } from "../src/shopify/client.js";
import { createInstallToken, createState, isValidCallbackHmac, readInstallToken, readState } from "../src/shopify/oauth.js";
import { registerShopifyRoutes } from "../src/shopify/routes.js";

const MASTER_KEY = randomBytes(32).toString("base64");
const APP = { apiKey: "app-key", apiSecret: "app-secret" };

let database: Database;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  database = await openDatabase({});
  const [t, o] = await database.db
    .insert(tenants)
    .values([
      { slug: "maius", name: "MAIUS" },
      { slug: "diger", name: "Diğer" },
    ])
    .returning();
  tenantId = t!.id;
  otherTenantId = o!.id;
});
afterAll(() => database.close());

describe("HTML → metin", () => {
  it("stil bloklarını atar, başlık ve listeleri korur, karakterleri çözer", () => {
    const html = `<style>.maius-hero{transition:transform 8s}</style><h2>Kargo &amp; Teslimat</h2>
      <p>DHL ile&nbsp;gönderilir.</p><ul><li>3.000 TL üzeri ücretsiz</li><li>Alt&#305; 180 TL</li></ul>`;
    expect(htmlToText(html)).toBe("## Kargo & Teslimat\n\nDHL ile gönderilir.\n\n- 3.000 TL üzeri ücretsiz\n- Altı 180 TL");
  });
});

describe("sayfa sınıflandırma", () => {
  it("hukuki sayfaları ayırır, boş sayfaları kapatır", () => {
    expect(classifyPage("Kişisel Verilerin Korunması Aydınlatma Metni", "kvkk", "x".repeat(500))).toEqual({ kind: "legal", autoEnabled: true });
    expect(classifyPage("Sıkça Sorulan Sorular", "sss", "x".repeat(500))).toEqual({ kind: "core", autoEnabled: true });
    expect(classifyPage("Favorilerim", "wishlist", "")).toEqual({ kind: "core", autoEnabled: false });
  });
});

describe("OAuth güvenliği", () => {
  it("imzalı state doğru mağaza ve sürede geçerli", () => {
    const state = createState("t1", "a.myshopify.com", "s", 1000);
    expect(readState(state, "a.myshopify.com", "s", 2000)).toEqual({ tenantId: "t1" });
    expect(readState(state, "b.myshopify.com", "s", 2000)).toBeNull();
    expect(readState(state, "a.myshopify.com", "başka", 2000)).toBeNull();
    expect(readState(state, "a.myshopify.com", "s", 1000 + 11 * 60 * 1000)).toBeNull();
  });

  it("kurulum token'ı 24 saat geçerli, değiştirilemez, state yerine kullanılamaz", () => {
    const token = createInstallToken("t1", "a.myshopify.com", "s", 1000);
    expect(readInstallToken(token, "s", 1000 + 23 * 60 * 60 * 1000)).toEqual({ tenantId: "t1", shop: "a.myshopify.com" });
    expect(readInstallToken(token, "s", 1000 + 25 * 60 * 60 * 1000)).toBeNull(); // süresi doldu
    expect(readInstallToken(token, "başka", 2000)).toBeNull(); // yanlış anahtar

    // İçeriği değiştirilmiş token (başka kiracı) imzayı bozar.
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ p: "install", t: "saldirgan", s: "a.myshopify.com", exp: 9e15 })).toString("base64url");
    expect(readInstallToken(`${forged}.${sig}`, "s", 2000)).toBeNull();

    // Amaçlar karışmaz.
    expect(readState(token, "a.myshopify.com", "s", 2000)).toBeNull();
    expect(readInstallToken(createState("t1", "a.myshopify.com", "s", 1000), "s", 2000)).toBeNull();
  });

  it("callback hmac'ini doğrular", () => {
    const query = { code: "c", shop: "a.myshopify.com", state: "x", timestamp: "1" };
    const message = "code=c&shop=a.myshopify.com&state=x&timestamp=1";
    const hmac = createHmac("sha256", "s").update(message).digest("hex");
    expect(isValidCallbackHmac({ ...query, hmac }, "s")).toBe(true);
    expect(isValidCallbackHmac({ ...query, code: "d", hmac }, "s")).toBe(false);
  });
});

// Sahte Shopify: MAIUS'taki yapıya benzer veri döndürür.
let pages = [
  { id: "gid://Page/1", title: "Sıkça Sorulan Sorular", handle: "sss", isPublished: true, updatedAt: "2026-09-20T00:00:00Z", body: "<p>Ürünler sipariş üzerine üretilir; üretim 3-5 iş günü sürer.</p>" },
  { id: "gid://Page/2", title: "Favorilerim", handle: "wishlist", isPublished: true, updatedAt: "2026-09-20T00:00:00Z", body: "" },
  { id: "gid://Page/3", title: "KVKK Aydınlatma Metni", handle: "kvkk", isPublished: true, updatedAt: "2026-09-20T00:00:00Z", body: `<p>${"Kişisel veriler... ".repeat(20)}</p>` },
  { id: "gid://Page/4", title: "Taslak", handle: "taslak", isPublished: false, updatedAt: "2026-09-20T00:00:00Z", body: "<p>yayında değil</p>" },
];
const fakeShopify: ShopifyApi = {
  async graphql<T>() {
    return {
      shop: {
        name: "MAIUS",
        contactEmail: "destek@maius.info",
        primaryDomain: { url: "https://maiusonline.com" },
        shopAddress: { city: "İstanbul", country: "Turkey", phone: "+90 506 282 40 52" },
        updatedAt: "2026-09-20T00:00:00Z",
        shopPolicies: [
          { type: "SHIPPING_POLICY", title: "Kargo", url: "https://maiusonline.com/policies/shipping-policy", updatedAt: "2026-09-21T00:00:00Z", body: "<p>Teslimat 1–7 gün.</p>" },
          { type: "TERMS_OF_SERVICE", title: "Hizmet şartları", url: "https://maiusonline.com/policies/terms", updatedAt: "2026-09-21T00:00:00Z", body: "<p>Mesafeli satış sözleşmesi...</p>" },
        ],
      },
      pages: { nodes: pages, pageInfo: { hasNextPage: false, endCursor: null } },
    } as T;
  },
};

async function createStore(shopDomain = "maius.myshopify.com", tId = tenantId): Promise<ShopifyStore> {
  const [store] = await database.db
    .insert(shopifyStores)
    .values({ tenantId: tId, shopDomain, scopes: "read_content", accessTokenEnc: encryptSecret("shpat_old", MASTER_KEY) })
    .onConflictDoUpdate({ target: shopifyStores.tenantId, set: { shopDomain } })
    .returning();
  return store!;
}

describe("bilgi senkronu", () => {
  it("politikaları, sayfaları ve künyeyi doğru sınıflarla kaydeder", async () => {
    const store = await createStore();
    const r = await syncStoreKnowledge(database.db, fakeShopify, store);
    expect(r).toEqual({ total: 6, changed: 6, removed: 0 });

    const docs = await database.db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, tenantId));
    const byTitle = Object.fromEntries(docs.map((d) => [d.title, d]));
    expect(byTitle["Sıkça Sorulan Sorular"]).toMatchObject({ kind: "core", autoEnabled: true, url: "https://maiusonline.com/pages/sss" });
    expect(byTitle["Favorilerim"]).toMatchObject({ autoEnabled: false });
    expect(byTitle["KVKK Aydınlatma Metni"]).toMatchObject({ kind: "legal" });
    expect(byTitle["Hizmet şartları"]).toMatchObject({ kind: "legal" });
    expect(byTitle["Kargo"]).toMatchObject({ kind: "core", content: "Teslimat 1–7 gün." });
    expect(byTitle["Mağaza künyesi"]!.content).toContain("Telefon: +90 506 282 40 52");
    expect(byTitle["Taslak"]).toBeUndefined();

    const kb = await loadKnowledge(database.db, (await database.db.select().from(tenants).where(eq(tenants.id, tenantId)))[0]!);
    expect(kb!.core.map((d) => d.title)).toEqual(["Mağaza künyesi", "Kargo", "Sıkça Sorulan Sorular"]);
    expect(kb!.legal.map((d) => d.title)).toEqual(["Hizmet şartları", "KVKK Aydınlatma Metni"]);
  });

  it("değişmeyenleri yazmaz, mağazanın seçimini korur, silinen sayfayı kaldırır", async () => {
    const store = await createStore();
    await syncStoreKnowledge(database.db, fakeShopify, store);
    await database.db.update(knowledgeDocs).set({ enabledOverride: false }).where(eq(knowledgeDocs.title, "Sıkça Sorulan Sorular"));

    expect(await syncStoreKnowledge(database.db, fakeShopify, store)).toEqual({ total: 6, changed: 0, removed: 0 });

    const original = pages;
    pages = [{ ...original[0]!, body: "<p>Üretim 5-7 iş günü.</p>" }, ...original.slice(2)];
    try {
      expect(await syncStoreKnowledge(database.db, fakeShopify, store)).toEqual({ total: 5, changed: 1, removed: 1 });
    } finally {
      pages = original;
    }
    const [faq] = await database.db.select().from(knowledgeDocs).where(eq(knowledgeDocs.title, "Sıkça Sorulan Sorular"));
    expect(faq).toMatchObject({ content: "Üretim 5-7 iş günü.", enabledOverride: false });
  });

  it("uygulama kaldırılınca Shopify bilgileri kullanılmaz, mağaza notları kullanılır", async () => {
    const store = await createStore();
    await syncStoreKnowledge(database.db, fakeShopify, store);
    const getTenant = async () => (await database.db.select().from(tenants).where(eq(tenants.id, tenantId)))[0]!;
    const legalId = (await loadKnowledge(database.db, await getTenant()))!.legal[0]!.id;

    await database.db.update(shopifyStores).set({ uninstalledAt: new Date() }).where(eq(shopifyStores.id, store.id));
    try {
      expect(await loadKnowledge(database.db, await getTenant())).toBeNull();
      expect(await readLegalDoc(database.db, tenantId, legalId)).toBeNull();

      await database.db.update(tenants).set({ notes: "Bayramda kargo çıkışı yok" }).where(eq(tenants.id, tenantId));
      expect(await loadKnowledge(database.db, await getTenant())).toEqual({ notes: "Bayramda kargo çıkışı yok", core: [], legal: [] });
    } finally {
      await database.db.update(tenants).set({ notes: "" }).where(eq(tenants.id, tenantId));
      await database.db.update(shopifyStores).set({ uninstalledAt: null }).where(eq(shopifyStores.id, store.id));
    }
  });

  it("arşivden gelen kampanya özeti Shopify senkronunda silinmez, kaynakların sonunda yer alır", async () => {
    const store = await createStore();
    await database.db.insert(knowledgeDocs).values({
      tenantId,
      source: "campaign",
      externalId: "digest",
      title: "Güncel kampanya ve duyuru yazıları",
      content: "Sitenin görünen yazıları (üst bant, ana sayfa):\n- 3.000 TL ve üzeri siparişlerde ücretsiz kargo",
      kind: "core",
      autoEnabled: true,
    });
    try {
      await syncStoreKnowledge(database.db, fakeShopify, store);
      const kb = await loadKnowledge(database.db, (await database.db.select().from(tenants).where(eq(tenants.id, tenantId)))[0]!);
      const titles = kb!.core.map((d) => d.title);
      expect(titles.slice(0, 2)).toEqual(["Mağaza künyesi", "Kargo"]);
      expect(titles.at(-1)).toBe("Güncel kampanya ve duyuru yazıları");
    } finally {
      await database.db.delete(knowledgeDocs).where(eq(knowledgeDocs.source, "campaign"));
    }
  });

  it("hata olursa mağaza kaydına yazar", async () => {
    const store = await createStore();
    const broken: ShopifyApi = { graphql: async () => { throw new Error("401 yetkisiz"); } };
    await expect(syncStoreKnowledge(database.db, broken, store)).rejects.toThrow();
    const [row] = await database.db.select().from(shopifyStores).where(eq(shopifyStores.id, store.id));
    expect(row!.lastSyncError).toBe("401 yetkisiz");
  });
});

describe("bilgi uzmanı araçları", () => {
  // Uzmanın çağıracağı aracı senaryoya göre seçen sahte model.
  function scriptedLlm(toolName: string, input: Record<string, unknown>): Llm & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    return {
      calls,
      async create(params) {
        calls.push(structuredClone(params));
        const last = params.messages.at(-1)!;
        const base = { id: "m", type: "message", role: "assistant", model: "x", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
          const r = last.content[0] as Anthropic.ToolResultBlockParam;
          return { ...base, stop_reason: "end_turn", content: [{ type: "text", text: `sonuç: ${String(r.content)}`, citations: null }] } as unknown as Anthropic.Message;
        }
        return { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: toolName, input }] } as unknown as Anthropic.Message;
      },
    };
  }

  async function kbFor(tId: string) {
    const [t] = await database.db.select().from(tenants).where(eq(tenants.id, tId));
    return { tenant: t!, kb: (await loadKnowledge(database.db, t!))! };
  }

  it("çelişkiyi panele uyarı olarak kaydeder, aynı konuyu tekrar açmaz", async () => {
    await syncStoreKnowledge(database.db, fakeShopify, await createStore());
    const { tenant, kb } = await kbFor(tenantId);
    const llm = scriptedLlm("report_conflict", { topic: "Teslimat süresi", description: "Kargo politikası 1-7 gün, SSS 10 gün diyor." });
    const ctx = { db: database.db, llm, model: "m", tenantId, conversationId: null };

    await askKnowledgeAgent(ctx, tenant, kb, "Kaç günde gelir?");
    await askKnowledgeAgent(ctx, tenant, kb, "Kaç günde gelir?");
    const alerts = await database.db.select().from(knowledgeAlerts).where(eq(knowledgeAlerts.tenantId, tenantId));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ topic: "Teslimat süresi", status: "open" });

    // Mağaza notları ve kaynaklar uzmanın sistem istemindedir; hukuki metinler sadece başlık.
    const system = (llm.calls[0]!.system as Anthropic.TextBlockParam[])[0]!.text;
    expect(system).toContain("Teslimat 1–7 gün.");
    expect(system).toContain("KVKK Aydınlatma Metni (doc_id:");
    expect(system).not.toContain("Kişisel veriler...");
  });

  it("hukuki metni sadece kendi mağazasından okur", async () => {
    await syncStoreKnowledge(database.db, fakeShopify, await createStore());
    const { tenant, kb } = await kbFor(tenantId);
    const kvkk = kb.legal.find((d) => d.title.startsWith("KVKK"))!;

    const own = scriptedLlm("read_legal_document", { doc_id: kvkk.id });
    expect(await askKnowledgeAgent({ db: database.db, llm: own, model: "m", tenantId, conversationId: null }, tenant, kb, "KVKK?")).toContain("Kişisel veriler...");

    // Başka bir mağaza aynı belge kimliğini isteyemez.
    const [other] = await database.db.select().from(tenants).where(eq(tenants.id, otherTenantId));
    const stolen = scriptedLlm("read_legal_document", { doc_id: kvkk.id });
    const answer = await askKnowledgeAgent(
      { db: database.db, llm: stolen, model: "m", tenantId: otherTenantId, conversationId: null },
      { ...other!, notes: "not" },
      { notes: "not", core: [], legal: [kvkk] },
      "KVKK?",
    );
    expect(answer).toContain("Belge bulunamadı");
    expect(answer).not.toContain("Kişisel veriler...");
  });
});

describe("token yenileme", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("süresi dolmak üzereyken yeniler, yeni token'ları kaydeder ve kullanır", async () => {
    const store = await createStore();
    await database.db
      .update(shopifyStores)
      .set({
        accessTokenExpiresAt: new Date(Date.now() + 60 * 1000),
        refreshTokenEnc: encryptSecret("shprt_old", MASTER_KEY),
      })
      .where(eq(shopifyStores.id, store.id));

    const requests: { url: string; body: string; token: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: String(init.body), token: new Headers(init.headers).get("x-shopify-access-token") });
      if (url.endsWith("/admin/oauth/access_token")) {
        return new Response(
          JSON.stringify({ access_token: "shpat_new", expires_in: 3600, refresh_token: "shprt_new", refresh_token_expires_in: 7776000, scope: "read_content" }),
        );
      }
      return new Response(JSON.stringify({ data: { ok: true } }));
    });

    const api = createShopifyApi({ db: database.db, masterKey: MASTER_KEY, app: APP, apiVersion: "2026-07" });
    expect(await api.graphql(store, "{ shop { name } }")).toEqual({ ok: true });

    expect(requests[0]!.body).toContain("grant_type=refresh_token");
    expect(requests[0]!.body).toContain("refresh_token=shprt_old");
    expect(requests[1]!.token).toBe("shpat_new");
    const [row] = await database.db.select().from(shopifyStores).where(eq(shopifyStores.id, store.id));
    expect(decryptSecret(row!.refreshTokenEnc!, MASTER_KEY)).toBe("shprt_new");
    expect(row!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
  });
});

describe("geçici hatalarda tekrar deneme", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Sırayla verilen cevapları döndüren sahte fetch; kaç istek atıldığını sayar. */
  function stubResponses(...responses: (() => Response)[]) {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      const next = responses[Math.min(calls, responses.length - 1)]!;
      calls++;
      return next();
    });
    return () => calls;
  }
  const ok = () => new Response(JSON.stringify({ data: { ok: true } }));
  const api = () => createShopifyApi({ db: database.db, masterKey: MASTER_KEY, app: APP, apiVersion: "2026-07", retryDelayMs: 1 });

  async function freshStore() {
    const store = await createStore();
    await database.db.update(shopifyStores).set({ accessTokenExpiresAt: null, uninstalledAt: null }).where(eq(shopifyStores.id, store.id));
    return store;
  }

  it("sunucu hatasından sonra tekrar dener ve başarır", async () => {
    const calls = stubResponses(() => new Response("<html>Bad Gateway</html>", { status: 502 }), ok);
    expect(await api().graphql(await freshStore(), "{ shop { name } }")).toEqual({ ok: true });
    expect(calls()).toBe(2);
  });

  it("yoğunluk (THROTTLED) hatasından sonra tekrar dener", async () => {
    const throttled = () =>
      new Response(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }));
    const calls = stubResponses(throttled, throttled, ok);
    expect(await api().graphql(await freshStore(), "{ shop { name } }")).toEqual({ ok: true });
    expect(calls()).toBe(3);
  });

  it("3 denemeden sonra anlaşılır bir hatayla vazgeçer", async () => {
    const calls = stubResponses(() => new Response("<html>Service Unavailable</html>", { status: 503 }));
    await expect(api().graphql(await freshStore(), "{ shop { name } }")).rejects.toThrow(
      "Shopify beklenmeyen cevap döndü (503): <html>Service Unavailable</html>",
    );
    expect(calls()).toBe(3);
  });

  it("kalıcı hatayı (hatalı sorgu) tekrar denemez", async () => {
    const calls = stubResponses(() => new Response(JSON.stringify({ errors: [{ message: "Field 'x' doesn't exist" }] })));
    await expect(api().graphql(await freshStore(), "{ x }")).rejects.toThrow("Shopify GraphQL hatası (200): Field 'x' doesn't exist");
    expect(calls()).toBe(1);
  });

  it("bağlantı koptuğunda tekrar dener", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      if (calls++ === 0) throw new TypeError("fetch failed");
      return ok();
    });
    expect(await api().graphql(await freshStore(), "{ shop { name } }")).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});

describe("Shopify adresleri", () => {
  let server: Server;
  let base: string;
  const synced: string[] = [];

  beforeAll(async () => {
    const app = express();
    registerShopifyRoutes(app, {
      db: database.db,
      shopify: { graphql: async <T>() => ({ webhookSubscriptionCreate: { userErrors: [] } }) as T },
      app: APP,
      appUrl: "https://app.example.com",
      masterKey: MASTER_KEY,
      syncStore: async (store) => synced.push(store.shopDomain),
      log: { info() {}, warn() {}, error() {} },
      exchange: async () => ({ access_token: "shpat_x", scope: "read_content", expires_in: 3600, refresh_token: "shprt_x", refresh_token_expires_in: 7776000 }),
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  beforeEach(async () => {
    synced.length = 0;
    await database.db.delete(shopifyStores);
  });

  const signedCallback = (params: Record<string, string>) => {
    const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    const hmac = createHmac("sha256", APP.apiSecret).update(message).digest("hex");
    return `${base}/shopify/callback?${new URLSearchParams({ ...params, hmac })}`;
  };

  it("imzalı linkle kurulum Shopify izin ekranına yönlendirir", async () => {
    const token = createInstallToken(tenantId, "maius.myshopify.com", APP.apiSecret);
    const res = await fetch(`${base}/shopify/install?token=${token}`, { redirect: "manual" });
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://maius.myshopify.com/admin/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("app-key");
    expect(location.searchParams.get("redirect_uri")).toBe("https://app.example.com/shopify/callback");
    expect(location.searchParams.get("scope")).toContain("read_legal_policies");
  });

  it("imzasız ya da eski biçimli kurulum linkini reddeder", async () => {
    const old = await fetch(`${base}/shopify/install?tenant=maius&shop=maius.myshopify.com`, { redirect: "manual" });
    expect(old.status).toBe(400);
    const junk = await fetch(`${base}/shopify/install?token=abc.def`, { redirect: "manual" });
    expect(junk.status).toBe(400);
    const otherSecret = createInstallToken(tenantId, "maius.myshopify.com", "baska-anahtar");
    expect((await fetch(`${base}/shopify/install?token=${otherSecret}`, { redirect: "manual" })).status).toBe(400);
  });

  it("geçerli callback mağazayı bağlar ve senkronu başlatır", async () => {
    const shop = "maius.myshopify.com";
    const res = await fetch(signedCallback({ code: "c1", shop, state: createState(tenantId, shop, APP.apiSecret), timestamp: "1" }));
    expect(res.status).toBe(200);
    const [store] = await database.db.select().from(shopifyStores);
    expect(store).toMatchObject({ tenantId, shopDomain: shop });
    expect(decryptSecret(store!.accessTokenEnc, MASTER_KEY)).toBe("shpat_x");
    expect(synced).toEqual([shop]);
  });

  it("imzası bozuk ya da başka mağazanın state'i reddedilir", async () => {
    const shop = "maius.myshopify.com";
    const good = signedCallback({ code: "c1", shop, state: createState(tenantId, shop, APP.apiSecret), timestamp: "1" });
    expect((await fetch(good.replace("code=c1", "code=c2"))).status).toBe(400);
    const wrongShop = signedCallback({ code: "c1", shop, state: createState(tenantId, "baska.myshopify.com", APP.apiSecret), timestamp: "1" });
    expect((await fetch(wrongShop)).status).toBe(400);
    expect(await database.db.select().from(shopifyStores)).toHaveLength(0);
  });

  it("uygulama kaldırma bildirimini işler, imzasızı reddeder", async () => {
    await createStore();
    const body = JSON.stringify({ id: 1 });
    const post = (hmac: string) =>
      fetch(`${base}/webhook/shopify`, {
        method: "POST",
        headers: { "x-shopify-hmac-sha256": hmac, "x-shopify-topic": "app/uninstalled", "x-shopify-shop-domain": "maius.myshopify.com" },
        body,
      });
    expect((await post("yanlis")).status).toBe(401);
    expect((await post(createHmac("sha256", APP.apiSecret).update(body).digest("base64"))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const [store] = await database.db.select().from(shopifyStores);
    expect(store!.uninstalledAt).not.toBeNull();
  });

  it("mağaza verisi silme bildirimi: bilgiler, arşiv ve kurulum silinir; vitrinden yeniden veri toplanmaz", async () => {
    await createStore();
    await database.db.update(tenants).set({ domain: "maiusonline.com" }).where(eq(tenants.id, tenantId));
    await recordSnapshot(database.db, tenantId, "site", [{ ref: "bant", title: "announcement-bar", content: "Kargo bedava", data: {} }], new Date());
    await database.db.insert(knowledgeDocs).values({
      tenantId,
      source: "campaign",
      externalId: "digest",
      title: "Güncel kampanya ve duyuru yazıları",
      content: "- Kargo bedava",
      kind: "core",
      autoEnabled: true,
    });
    // Sipariş uzmanının siparişten türettiği kayıt; Lina'nın kendi kaydı dokunulmadan kalır.
    await database.db.insert(agentRuns).values([
      { tenantId, agent: "order", model: "m", input: "MO-1271 nerede?", output: "Sipariş #MO-1271 kargoda (Yurtiçi, takip 123)" },
      { tenantId, agent: "lina", model: "m", input: "merhaba", output: "Merhaba" },
    ]);
    const body = JSON.stringify({ shop_id: 1, shop_domain: "maius.myshopify.com" });
    const res = await fetch(`${base}/webhook/shopify`, {
      method: "POST",
      headers: {
        "x-shopify-hmac-sha256": createHmac("sha256", APP.apiSecret).update(body).digest("base64"),
        "x-shopify-topic": "shop/redact",
        "x-shopify-shop-domain": "maius.myshopify.com",
      },
      body,
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(await database.db.select().from(shopifyStores)).toHaveLength(0);
    expect(await database.db.select().from(textArchive).where(eq(textArchive.tenantId, tenantId))).toHaveLength(0);
    expect(await database.db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, tenantId))).toHaveLength(0);
    const [tenant] = await database.db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant!.domain).toBeNull();
    const runs = await database.db.select().from(agentRuns).where(eq(agentRuns.tenantId, tenantId));
    expect(runs.find((r) => r.agent === "order")).toMatchObject({ input: null, output: null });
    expect(runs.find((r) => r.agent === "lina")).toMatchObject({ input: "merhaba", output: "Merhaba" });
  });
});
