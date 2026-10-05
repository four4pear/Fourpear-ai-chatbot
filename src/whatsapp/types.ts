// Cloud API webhook yükünün kullandığımız kısmı.
export type WaIncomingMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  [key: string]: unknown;
};

export type WaChangeValue = {
  messaging_product: "whatsapp";
  metadata: { phone_number_id: string; display_phone_number?: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: WaIncomingMessage[];
  statuses?: unknown[];
};

export type WaWebhookPayload = {
  object: string;
  entry?: { id: string; changes?: { field: string; value: WaChangeValue }[] }[];
};

export type InboundEvent = {
  phoneNumberId: string;
  message: WaIncomingMessage;
  contactName?: string;
  /** Aracı servisteki (Zernio) konuşma kimliği; cevap bununla gönderilir. */
  chatRef?: string;
};

/** Webhook yükünden müşteri mesajlarını çıkarır; teslim/okundu durumlarını atlar. */
export function extractInboundEvents(payload: WaWebhookPayload): InboundEvent[] {
  const events: InboundEvent[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      for (const message of value.messages ?? []) {
        const contact = value.contacts?.find((c) => c.wa_id === message.from);
        events.push({
          phoneNumberId: value.metadata.phone_number_id,
          message,
          contactName: contact?.profile?.name,
        });
      }
    }
  }
  return events;
}
