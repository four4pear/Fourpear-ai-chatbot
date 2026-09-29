import { z } from "zod";
import { textAt } from "../archive/archive.js";
import type { Tenant } from "../db/schema.js";
import { buildOrderSheet, orderSummaryLine, type OrderIssue, type ProductTextAt } from "../orders/facts.js";
import { belongsTo, sameOrderNumber, type OrderFacts, type OrderSource } from "../orders/types.js";
import { RETURN_STATUS_LABELS, type ReturnRequestInfo, type ReturnsProvider } from "../returns/provider.js";
import { orderAgentSystemPrompt } from "./prompts.js";
import { runAgent, type AgentContext, type AgentTool } from "./runner.js";

/** Lina'nın sipariş uzmanına sorarken seçtiği konu; ekibe gidecek bildirimin türünü belirler. */
export const ORDER_TOPICS = ["status", "cancel", "change", "return", "complaint", "return_status", "other"] as const;
export type OrderTopic = (typeof ORDER_TOPICS)[number];

/** Bir cevap boyunca sipariş konusunda bulunanlar; cevap gönderilince ekibe bildirim bunlardan kurulur. */
export type OrderFindings = {
  topics: OrderTopic[];
  /** Doğrulanmış (müşteriye ait) ve bakılan siparişler. */
  orders: Map<string, { unshipped: boolean; cancelled: boolean }>;
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

export type OrderRequest = { topic: OrderTopic; question: string; orderNumber: string | null };

const TOPIC_LABELS: Record<OrderTopic, string> = {
  status: "sipariş durumu, kargo, ön sipariş",
  cancel: "iptal isteği",
  change: "kargodan önce değişiklik isteği (beden, renk, adres)",
  return: "iade / değişim isteği",
  complaint: "şikayet (hasarlı, hatalı, yanlış ürün ya da gelmeyen teslimat)",
  return_status: "iade talebinin durumu",
  other: "diğer",
};

const UNVERIFIED =
  "DOĞRULANAMADI: Müşterinin WhatsApp numarasına ait böyle bir sipariş bulunamadı. Sipariş bilgisi paylaşılamaz ve siparişin var olup olmadığı söylenmez; müşteriden siparişte kullandığı telefon numarasından yazması istenir.";

const orderNumberInput = z.object({ order_number: z.string().min(1) });
const delayInput = z.object({ order_number: z.string().min(1), product: z.string().min(1), planned_date: z.string().min(1) });

function addIssue(findings: OrderFindings, issue: OrderIssue) {
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
 * Sipariş uzmanı: siparişi doğrular, bilgi kartını okur ve müşterinin sorusuna Lina için cevap yazar.
 * Doğrulama ve gecikme/takip tespiti kodda yapılır; model yalnızca yorumlar.
 */
export async function askOrderAgent(
  ctx: AgentContext,
  tenant: Tenant,
  deps: OrderAgentDeps,
  request: OrderRequest,
  findings: OrderFindings,
): Promise<string> {
  const withReturns = deps.returns && ["return", "return_status", "complaint"].includes(request.topic);

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

  const sheetFor = async (order: OrderFacts): Promise<string> => {
    const texts = new Map<string, ProductTextAt | null>();
    for (const item of order.items) {
      if (item.productId && !texts.has(item.productId)) {
        texts.set(item.productId, await textAt(ctx.db, tenant.id, "product", item.productId, order.createdAt));
      }
    }
    const sheet = buildOrderSheet(order, texts, deps.now, deps.timeZone);
    findings.orders.set(order.name, { unshipped: sheet.unshipped, cancelled: sheet.cancelled });
    for (const issue of sheet.issues) addIssue(findings, issue);
    return withReturns ? `${sheet.text}\n\n${await returnInfo(order.name)}` : sheet.text;
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
    if (!order || !belongsTo(order, deps.waId)) {
      findings.unverified = true;
      return UNVERIFIED;
    }
    return sheetFor(order);
  };

  const findMine = async (): Promise<string> => {
    const mine = (await deps.source.byPhone(deps.waId)).filter((o) => belongsTo(o, deps.waId)).slice(0, 5);
    if (!mine.length) {
      findings.unverified = true;
      return "Müşterinin WhatsApp numarasıyla eşleşen sipariş bulunamadı (son 60 gün). Müşteriden sipariş numarasını iste; sipariş başka bir telefon numarasıyla verildiyse o numaradan yazması gerekir.";
    }
    if (mine.length === 1) return sheetFor(mine[0]!);
    return [
      "Müşterinin WhatsApp numarasıyla eşleşen siparişler (yeniden eskiye):",
      ...mine.map((o) => `- ${orderSummaryLine(o, deps.timeZone)}`),
      "Soru hangi siparişle ilgili belli değilse müşteriye sorulmalı; belliyse ayrıntı için get_order kullan.",
    ].join("\n");
  };

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
    {
      definition: {
        name: "report_delay",
        description:
          "Bilgi kartının GECİKME olarak işaretlemediği ama tarihi geçmiş ve henüz kargoya verilmemiş bir ön siparişi ekibe bildirir.",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            order_number: { type: "string" },
            product: { type: "string", description: "Ürün ve varyant, ör. Lavin Etek (Siyah)" },
            planned_date: { type: "string", description: "Açıklamadaki planlanan kargo tarihi, ör. 25 Eylül 2026" },
          },
          required: ["order_number", "product", "planned_date"],
          additionalProperties: false,
        },
      },
      run: async (input) => {
        const { order_number, product, planned_date } = delayInput.parse(input);
        const name = [...findings.orders.keys()].find((n) => sameOrderNumber(n, order_number));
        if (!name) throw new Error("Bu sipariş doğrulanmadı; önce get_order ile bakılmalı.");
        addIssue(findings, { kind: "delay", orderName: name, text: `Gecikme: ${product}, planlanan kargo ${planned_date}` });
        return "Gecikme ekibe bildirilecek.";
      },
    },
  ];

  // Çoğu soruda tek model çağrısı yetsin: sipariş önceden okunur.
  const prefetched = request.orderNumber ? await getOrder(request.orderNumber) : await findMine();

  const result = await runAgent(ctx, {
    agent: "order",
    system: orderAgentSystemPrompt(tenant, { returns: Boolean(deps.returns) }),
    messages: [{ role: "user", content: `Konu: ${TOPIC_LABELS[request.topic]}\nSoru: ${request.question}\n\n${prefetched}` }],
    tools,
    effort: "low",
    inputLabel: `[${TOPIC_LABELS[request.topic]}] ${request.question}${request.orderNumber ? ` (${request.orderNumber})` : ""}`,
  });
  if (result.stopReason === "refusal" || !result.text) return "Sipariş uzmanı bu soruya cevap veremedi.";
  return result.text;
}
