import { z } from "zod";
import { textAt } from "../archive/archive.js";
import { resolveSettings, type Tenant } from "../db/schema.js";
import { normalizePhone } from "../lib/phone.js";
import { buildOrderSheet, orderSummaryLine, type OrderIssue, type ProductTextAt } from "../orders/facts.js";
import { belongsTo, nameMatches, sameOrderNumber, type OrderFacts, type OrderSource } from "../orders/types.js";
import { RETURN_STATUS_LABELS, type ReturnRequestInfo, type ReturnsProvider } from "../returns/provider.js";
import type { AgentContext, AgentTool } from "./runner.js";

/** Lina'nın uzmanlara sorarken seçtiği konu; ekibe gidecek bildirimin türünü belirler. */
export const ORDER_TOPICS = ["status", "cancel", "change", "return", "complaint", "return_status", "other"] as const;
export type OrderTopic = (typeof ORDER_TOPICS)[number];

/** Bir cevap boyunca sipariş ve iade konusunda bulunanlar; cevap gönderilince ekibe bildirim bunlardan kurulur. */
export type OrderFindings = {
  topics: OrderTopic[];
  /** Doğrulanmış (müşteriye ait) ve bakılan siparişler. */
  /** byName: WhatsApp numarasıyla değil, müşterinin yazdığı ad soyadla doğrulandı (ekip işlemden önce teyit eder). */
  orders: Map<string, { unshipped: boolean; cancelled: boolean; byName?: boolean }>;
  issues: OrderIssue[];
  /** Müşterinin sorduğu sipariş doğrulanamadı ya da numarasına ait sipariş yok. */
  unverified: boolean;
  /** Sipariş sistemine ulaşılamadı (Shopify ya da uzman hatası): istek ekibe önemli bildirimle kalır. */
  lookupFailed: boolean;
};

export const newFindings = (): OrderFindings => ({ topics: [], orders: new Map(), issues: [], unverified: false, lookupFailed: false });

export type OrderAgentDeps = {
  source: OrderSource;
  /** Müşterinin WhatsApp numarası: sipariş yalnızca bununla eşleşirse gösterilir. */
  waId: string;
  timeZone: string;
  now: Date;
  returns: ReturnsProvider | null;
};

/**
 * Müşterinin doğrulama için yazdıkları (docs/lina-davranis.md §3.1): WhatsApp numarası siparişle
 * eşleşmezse ad soyad, sipariş numarasıyla ya da siparişteki telefonla birlikte tutmalı.
 */
export type CustomerIdentity = { name: string; orderPhone: string };

/** Sipariş numarası verildi ama numara tutmuyor ya da böyle sipariş yok (hangisi olduğu söylenmez). */
export const NEEDS_NAME =
  "DOĞRULAMA GEREKLİ: Müşterinin WhatsApp numarası bu siparişle eşleşmiyor ya da böyle bir sipariş yok (hangisi olduğunu söyleme). Sipariş bilgisi paylaşılamaz; müşteriden siparişte kayıtlı adını ve soyadını iste, sonra ad soyadla tekrar sorulmalı.";

/** Sipariş numarası yok ve WhatsApp numarasıyla eşleşen sipariş yok. */
export const NEEDS_IDENTITY =
  "DOĞRULAMA GEREKLİ: Müşterinin WhatsApp numarasıyla eşleşen sipariş bulunamadı (son 60 gün). Müşteriden sipariş numarasını ve siparişte kayıtlı adını soyadını iste; sipariş numarasını bilmiyorsa siparişte kayıtlı telefon numarasını ve adını soyadını iste.";

export const UNVERIFIED =
  "DOĞRULANAMADI: Müşterinin verdiği bilgilerle (sipariş numarası ya da siparişteki telefon ve ad soyad) eşleşen sipariş bulunamadı. Sipariş bilgisi paylaşılamaz ve siparişin var olup olmadığı söylenmez; müşteriden bilgileri kontrol edip tekrar yazması istenir.";

const orderNumberInput = z.object({ order_number: z.string().min(1) });

export function addIssue(findings: OrderFindings, issue: OrderIssue) {
  if (!findings.issues.some((i) => i.kind === issue.kind && i.text === issue.text)) findings.issues.push(issue);
}

const returnLabel = (status: string | null) => (status ? (RETURN_STATUS_LABELS[status] ?? status) : "durum bilinmiyor");

function describeReturn(r: ReturnRequestInfo): string {
  const type = r.type === "EXCHANGE" ? "değişim" : r.type === "REFUND" ? "para iadesi" : (r.type ?? "tür belirtilmemiş");
  const lines = [`- Talep ${r.code ?? "(kodsuz)"} (${type}): ${returnLabel(r.status)}${r.createdAt ? `; açılış ${r.createdAt}` : ""}`];
  if (r.history.length) lines.push(`  Geçmiş: ${r.history.map((h) => `${returnLabel(h.status)}${h.at ? ` (${h.at})` : ""}`).join(" → ")}`);
  if (r.returnShippingCode) lines.push(`  İade kargo kodu: ${r.returnShippingCode}${r.carrier ? ` (${r.carrier})` : ""}`);
  const items = r.items.filter((i) => i.title);
  if (items.length) lines.push(`  Ürünler: ${items.map((i) => [i.title, i.variant].filter(Boolean).join(" ")).join(", ")}`);
  return lines.join("\n");
}

/**
 * Sipariş ve iade uzmanlarının ortak sipariş erişimi. Doğrulama kodda yapılır: sipariş yalnızca
 * müşterinin WhatsApp numarasıyla eşleşirse bilgi kartı döner; model yalnızca yorumlar.
 * withReturns: bilgi kartına iade sistemindeki talebin durumu da eklenir.
 */
export function orderLookup(
  ctx: AgentContext,
  tenant: Tenant,
  deps: OrderAgentDeps,
  findings: OrderFindings,
  opts: { withReturns: boolean; identity?: CustomerIdentity },
) {
  const typedName = opts.identity?.name.trim() ?? "";
  const typedPhone = opts.identity?.orderPhone.trim()
    ? normalizePhone(opts.identity.orderPhone, resolveSettings(tenant.settings).phoneCountryCode)
    : "";
  /** Siparişte ad soyad hiç yoksa Shopify'da ad izni (Protected customer data: Name) verilmemiş olabilir. */
  const warnIfNoNames = (order: OrderFacts) => {
    if (typedName && order.names.length === 0) {
      ctx.log?.warn(
        `[sipariş] ${order.name} ad soyad bilgisi olmadan geldi: Shopify uygulamasına "Protected customer data" (Name) izni verilmemiş olabilir; ad soyadla doğrulama çalışmaz.`,
      );
    }
  };

  const returnInfo = async (orderName: string): Promise<string> => {
    try {
      const requests = await deps.returns!.requestsFor(orderName);
      if (!requests.length) return `İADE TALEBİ: ${orderName} için iade sisteminde açılmış talep yok.`;
      return ["İADE TALEBİ (iade sisteminden):", ...requests.map(describeReturn)].join("\n");
    } catch (err) {
      ctx.log?.warn(`[sipariş] iade sistemine ulaşılamadı: ${err instanceof Error ? err.message : String(err)}`);
      return "İADE TALEBİ: İade sistemine şu an ulaşılamadı; talebin durumu söylenemez.";
    }
  };

  const sheetFor = async (order: OrderFacts, verifiedBy: "whatsapp" | "name" = "whatsapp"): Promise<string> => {
    const texts = new Map<string, ProductTextAt | null>();
    for (const item of order.items) {
      if (item.productId && !texts.has(item.productId)) {
        texts.set(item.productId, await textAt(ctx.db, tenant.id, "product", item.productId, order.createdAt));
      }
    }
    const sheet = buildOrderSheet(order, texts, deps.now, deps.timeZone, verifiedBy);
    findings.orders.set(order.name, { unshipped: sheet.unshipped, cancelled: sheet.cancelled, ...(verifiedBy === "name" ? { byName: true } : {}) });
    for (const issue of sheet.issues) addIssue(findings, issue);
    return opts.withReturns && deps.returns ? `${sheet.text}\n\n${await returnInfo(order.name)}` : sheet.text;
  };

  const getOrder = async (typed: string): Promise<string> => {
    const order = await deps.source.byName(typed);
    // Telefon alanlarının hepsi boşsa büyük ihtimalle Shopify'da korumalı müşteri verisi (telefon)
    // izni yok: Lina hiçbir siparişi doğrulayamaz. Sessiz kalmasın.
    if (order && order.phones.length === 0) {
      ctx.log?.warn(
        `[sipariş] ${order.name} telefon bilgisi olmadan geldi: Shopify uygulamasına "Protected customer data" (telefon) izni verilmemiş olabilir; siparişler doğrulanamaz.`,
      );
    }
    if (order && belongsTo(order, deps.waId)) return sheetFor(order);
    if (order) warnIfNoNames(order);
    // Numara tutmuyor: sipariş numarası + siparişteki ad soyad birlikte tutmalı.
    if (order && typedName && nameMatches(order, typedName)) return sheetFor(order, "name");
    findings.unverified = true;
    return typedName ? UNVERIFIED : NEEDS_NAME;
  };

  /** Sipariş numarası bilinmiyorsa: siparişteki telefon + ad soyad birlikte tutmalı. */
  const findByTypedPhone = async (): Promise<OrderFacts[]> => {
    if (!typedPhone || !typedName) return [];
    const found = (await deps.source.byPhone(typedPhone)).filter((o) => belongsTo(o, typedPhone));
    found.forEach(warnIfNoNames);
    return found.filter((o) => nameMatches(o, typedName));
  };

  const findMine = async (): Promise<string> => {
    const byWhatsApp = (await deps.source.byPhone(deps.waId)).filter((o) => belongsTo(o, deps.waId));
    const mine = (byWhatsApp.length ? byWhatsApp : await findByTypedPhone()).slice(0, 5);
    if (!mine.length) {
      findings.unverified = true;
      return typedPhone && typedName ? UNVERIFIED : NEEDS_IDENTITY;
    }
    if (mine.length === 1) return sheetFor(mine[0]!, byWhatsApp.length ? "whatsapp" : "name");
    return [
      byWhatsApp.length
        ? "Müşterinin WhatsApp numarasıyla eşleşen siparişler (yeniden eskiye):"
        : "Müşterinin verdiği telefon ve ad soyadla eşleşen siparişler (yeniden eskiye):",
      ...mine.map((o) => `- ${orderSummaryLine(o, deps.timeZone)}`),
      "Soru hangi siparişle ilgili belli değilse müşteriye sorulmalı; belliyse ayrıntı için get_order kullan.",
    ].join("\n");
  };

  /** Bu cevapta doğrulanmış siparişin kayıtlı adı (ör. "#MO-9002"); doğrulanmadıysa undefined. */
  const verifiedName = (typed: string) => [...findings.orders.keys()].find((n) => sameOrderNumber(n, typed));

  const tools: AgentTool[] = [
    {
      definition: {
        name: "get_order",
        description: "Sipariş numarasıyla siparişin bilgi kartını getirir. Yalnızca müşterinin WhatsApp numarasına ait siparişler gösterilir.",
        strict: true,
        input_schema: {
          type: "object",
          properties: { order_number: { type: "string", description: "Sipariş numarası, ör. #1271" } },
          required: ["order_number"],
          additionalProperties: false,
        },
      },
      run: async (input) => getOrder(orderNumberInput.parse(input).order_number),
    },
    {
      definition: {
        name: "find_my_orders",
        description: "Müşterinin WhatsApp numarasıyla eşleşen son siparişleri listeler (tek sipariş varsa bilgi kartını getirir).",
        strict: true,
        input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
      run: async () => findMine(),
    },
  ];

  /** Çoğu soruda tek model çağrısı yetsin: sipariş önceden okunur. */
  const prefetch = (orderNumber: string | null) => (orderNumber ? getOrder(orderNumber) : findMine());

  return { tools, prefetch, verifiedName };
}
