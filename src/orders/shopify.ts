import type { ShopifyStore } from "../db/schema.js";
import { htmlToText } from "../knowledge/html.js";
import { normalizePhone } from "../lib/phone.js";
import type { ShopifyApi } from "../shopify/client.js";
import { sameOrderNumber, type OrderFacts, type OrderSource } from "./types.js";

// Tutar, ödeme ve adres alanları bilerek istenmez; telefonlar yalnızca doğrulama için.
const ORDER_FIELDS = `
      name
      createdAt
      cancelledAt
      phone
      customer { defaultPhoneNumber { phoneNumber } }
      shippingAddress { phone }
      billingAddress { phone }
      lineItems(first: 50) {
        nodes {
          id
          title
          variantTitle
          currentQuantity
          unfulfilledQuantity
          product { legacyResourceId descriptionHtml options(first: 10) { optionValues { name } } }
          variant { selectedOptions { name value } }
        }
      }
      fulfillments(first: 20) {
        createdAt
        status
        displayStatus
        deliveredAt
        requiresShipping
        trackingInfo(first: 5) { company number url }
        fulfillmentLineItems(first: 50) { nodes { lineItem { id } } }
      }`;

const ORDERS_QUERY = `#graphql
query LinaOrders($query: String!, $first: Int!) {
  orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
    nodes {${ORDER_FIELDS}
    }
  }
}`;

const CUSTOMERS_QUERY = `#graphql
query LinaCustomersByPhone($query: String!) {
  customers(first: 3, query: $query) { nodes { legacyResourceId } }
}`;

type GqlOrder = {
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  phone: string | null;
  customer: { defaultPhoneNumber: { phoneNumber: string } | null } | null;
  shippingAddress: { phone: string | null } | null;
  billingAddress: { phone: string | null } | null;
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      currentQuantity: number;
      unfulfilledQuantity: number;
      product: {
        legacyResourceId: string;
        descriptionHtml: string;
        options: { optionValues: { name: string }[] }[];
      } | null;
      variant: { selectedOptions: { name: string; value: string }[] } | null;
    }[];
  };
  fulfillments: {
    createdAt: string;
    status: string;
    displayStatus: string | null;
    deliveredAt: string | null;
    requiresShipping: boolean;
    trackingInfo: { company: string | null; number: string | null; url: string | null }[];
    fulfillmentLineItems: { nodes: { lineItem: { id: string } }[] };
  }[];
};

type OrdersResult = { orders: { nodes: GqlOrder[] } };

/** İptal edilmiş ya da hatalı gönderimler kargo bilgisi sayılmaz. */
const DEAD_FULFILLMENT = new Set(["CANCELLED", "ERROR", "FAILURE"]);

/** `countryCode`: mağazanın ülke kodu; ülke kodu olmadan yazılmış telefonlar buna göre tamamlanır. */
export function toOrderFacts(o: GqlOrder, countryCode = "90"): OrderFacts {
  const phones = [o.phone, o.customer?.defaultPhoneNumber?.phoneNumber, o.shippingAddress?.phone, o.billingAddress?.phone]
    .filter((p): p is string => Boolean(p?.trim()))
    .map((p) => normalizePhone(p, countryCode));
  return {
    name: o.name,
    createdAt: new Date(o.createdAt),
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
    phones: [...new Set(phones)],
    items: o.lineItems.nodes.map((li) => ({
      id: li.id,
      productId: li.product?.legacyResourceId ? String(li.product.legacyResourceId) : null,
      title: li.title,
      variantTitle: li.variantTitle,
      options: li.variant?.selectedOptions ?? [],
      productOptionValues: li.product?.options.flatMap((opt) => opt.optionValues.map((v) => v.name)) ?? [],
      quantity: li.currentQuantity,
      unfulfilled: li.unfulfilledQuantity,
      currentDescription: li.product?.descriptionHtml ? htmlToText(li.product.descriptionHtml) : null,
    })),
    shipments: o.fulfillments
      .filter((f) => !DEAD_FULFILLMENT.has(f.status))
      .map((f) => ({
        createdAt: new Date(f.createdAt),
        status: f.displayStatus ?? f.status,
        deliveredAt: f.deliveredAt ? new Date(f.deliveredAt) : null,
        carrier: f.trackingInfo[0]?.company ?? null,
        trackingNumber: f.trackingInfo[0]?.number ?? null,
        trackingUrl: f.trackingInfo[0]?.url ?? null,
        itemIds: f.fulfillmentLineItems.nodes.map((n) => n.lineItem.id),
        requiresShipping: f.requiresShipping,
      })),
  };
}

/**
 * Shopify siparişleri. Sipariş numarası "name:" filtresiyle aranır (#MO-1270, MO-1270 ve 1270
 * aynı siparişi bulur); serbest arama başka siparişleri de getirdiği için kullanılmaz.
 * Telefonla arama müşteri kaydı üzerinden yapılır. Sahiplik her durumda ayrıca doğrulanır.
 */
export function shopifyOrderSource(shopify: ShopifyApi, store: ShopifyStore, opts: { countryCode?: string } = {}): OrderSource {
  const countryCode = opts.countryCode ?? "90";
  const orders = async (query: string, first: number) =>
    (await shopify.graphql<OrdersResult>(store, ORDERS_QUERY, { query, first })).orders.nodes;

  return {
    async byName(typed) {
      const digits = typed.match(/\d+/g)?.join("");
      if (!digits) return null;
      const match = (await orders(`name:${digits}`, 5)).find((o) => sameOrderNumber(o.name, typed));
      return match ? toOrderFacts(match, countryCode) : null;
    },

    async byPhone(phone) {
      // WhatsApp numarası her zaman ülke koduyla gelir.
      const e164 = `+${normalizePhone(phone)}`;
      const { customers } = await shopify.graphql<{ customers: { nodes: { legacyResourceId: string }[] } }>(
        store,
        CUSTOMERS_QUERY,
        { query: `phone:${e164}` },
      );
      const found = new Map<string, GqlOrder>();
      for (const c of customers.nodes) {
        for (const o of await orders(`customer_id:${c.legacyResourceId}`, 10)) found.set(o.name, o);
      }
      return [...found.values()]
        .map((o) => toOrderFacts(o, countryCode))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
  };
}
