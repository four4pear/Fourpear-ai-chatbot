/**
 * Panel için canlı olaylar: bir konuşmada bir şey değişince o mağazanın açık panellerine
 * "şu konuşma değişti" sinyali gider. Olayda mesaj metni ya da müşteri bilgisi taşınmaz;
 * panel ayrıntıyı yetki kontrolünden geçen API'den ister.
 *
 * Tek sunucu için bellek içi. Birden fazla sunucuya çıkılırsa Postgres LISTEN/NOTIFY'a taşınır.
 */
export type PanelEvent =
  /** Konuşmaya mesaj eklendi (müşteri, Lina ya da ekip). */
  | { type: "message"; conversationId: string }
  /** Durum değişti: devredildi, devralındı, bota geri verildi. */
  | { type: "conversation"; conversationId: string }
  /** Yeni devir: konuşma bekleyenlere düştü (sesli uyarı/bildirim için). */
  | { type: "handoff"; conversationId: string }
  /** Sipariş konusunda ekibe yeni bildirim; önemliyse panelde sesli uyarı. */
  | { type: "notification"; conversationId: string; important: boolean }
  /** Bildirim tamamlandı: açık paneller listeyi yenilesin. */
  | { type: "notification_update"; conversationId: string };

type Listener = (event: PanelEvent) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(tenantId: string, listener: Listener): () => void {
    let set = this.listeners.get(tenantId);
    if (!set) this.listeners.set(tenantId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(tenantId);
    };
  }

  publish(tenantId: string, event: PanelEvent) {
    for (const listener of this.listeners.get(tenantId) ?? []) {
      try {
        listener(event);
      } catch {
        // Bir panelin bağlantı hatası diğerlerini etkilemesin.
      }
    }
  }

  /** Testler ve izleme için: bu mağazayı dinleyen panel sayısı. */
  listenerCount(tenantId: string): number {
    return this.listeners.get(tenantId)?.size ?? 0;
  }
}
