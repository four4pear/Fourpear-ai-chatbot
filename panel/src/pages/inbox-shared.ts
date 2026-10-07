import { useEffect } from "react";
import { LIVE_EVENT } from "../api";

// Gelen kutusunun (bekleyenler, sohbetler, konuşma) ortak tipleri ve yardımcıları.

export type Status = "bot" | "waiting" | "human";
export type Person = { id: string; name: string };
export type Customer = { name: string; phone: string };
export type Handoff = { reason: string; summary: string; createdAt: string };

export type ConversationRow = {
  id: string;
  status: Status;
  updatedAt: string;
  customer: Customer;
  assignedTo: Person | null;
  openHandoff: Handoff | null;
  lastMessage: { sender: string; type: string; text: string | null; createdAt: string } | null;
};

/** Lina'nın ekibe sorduğu, cevabı beklenen soru (konuşma ayrıntısında da aynı biçimde gelir). */
export type Question = {
  id: string;
  conversationId: string;
  customer: Customer;
  question: string;
  context: string;
  customerMessage: string | null;
  status: "open" | "answered";
  answer: string | null;
  answeredBy: { name: string } | null;
  answeredAt: string | null;
  createdAt: string;
};

/** Ekibe iletilen talep: Lina'nın ekibe bıraktığı önemli bildirim (şikayet, iade kararı, iptal, gecikme…). */
export type Forwarded = {
  id: string;
  conversationId: string;
  customer: Customer;
  kind: string;
  label: string;
  orderNames: string[];
  question: string;
  answer: string;
  issues: string[];
  createdAt: string;
  /** Müşteri aynı vakada yeniden yazdıysa: kartın son güncellendiği an. */
  updatedAt: string | null;
  doneAt: string | null;
  doneBy: { name: string } | null;
};

export const HANDOFF_REASONS: Record<string, string> = {
  customer_request: "Temsilci istedi",
  complaint: "Şikayet",
  return_or_cancel: "İade ya da iptal",
  unknown_answer: "Cevabı bilinmiyor",
  other: "Diğer",
};

/** Yazı ve fotoğraf dışındaki mesajların içeriği saklanmaz; ne olduğu yazılır. */
export const TYPE_LABELS: Record<string, string> = {
  audio: "Ses mesajı", video: "Video", document: "Belge", location: "Konum", contacts: "Kişi kartı",
  reaction: "Tepki", sticker: "Çıkartma", button: "Buton yanıtı", interactive: "Etkileşimli mesaj",
};

export const statusLabel = (c: { status: Status; assignedTo: Person | null }) =>
  c.status === "human" ? `Ekipte${c.assignedTo ? `: ${c.assignedTo.name}` : ""}` : c.status === "waiting" ? "Ekibi bekliyor" : "Lina cevaplıyor";

export const preview = (m: ConversationRow["lastMessage"]) => {
  if (!m) return "";
  // Ekibin Lina'ya cevabı iç bilgidir; müşteriye giden bir mesaj gibi görünmesin.
  if (m.type === "team_answer") return "Ekip Lina’nın sorusunu cevapladı";
  const who = m.sender === "customer" ? "Müşteri" : m.sender === "agent" ? "Ekip" : "Lina";
  return `${who}: ${m.text?.trim() || (m.type === "image" ? "Fotoğraf" : (TYPE_LABELS[m.type] ?? "Mesaj"))}`;
};

export const dateTime = (iso: string) => new Date(iso).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const clock = (iso: string) => new Date(iso).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
export const dayOf = (iso: string) => new Date(iso).toLocaleDateString("tr-TR", { day: "numeric", month: "long" });

export function initials(name: string) {
  // Adı olmayan müşteride (yalnızca telefon) baş harf yoktur.
  const parts = name.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return parts.slice(0, 2).map((w) => (w.match(/\p{L}/u)?.[0] ?? "").toLocaleUpperCase("tr-TR")).join("") || "?";
}

/** Bekleme süresi: "az önce", "42 dk", "3 sa", "2 gün". 20 dakikayı geçen bekleme vurgulanır (Lina'nın ekibe hatırlatma süresi). */
export const LATE_MINUTES = 20;
export function waitMinutes(iso: string, now = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}
export function waitLabel(iso: string, now = Date.now()) {
  const m = waitMinutes(iso, now);
  if (m < 1) return "az önce";
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} sa` : `${Math.floor(h / 24)} gün`;
}
/** "42 dk önce" gibi cümle içi kullanım. */
export const ago = (iso: string, now = Date.now()) => (waitMinutes(iso, now) < 1 ? "az önce" : `${waitLabel(iso, now)} önce`);

// --- Bekleyenler kuyruğu: üç kaynak (Lina'nın soruları, ekibe iletilenler, devredilen konuşmalar) tek listede ---

export type Tone = "red" | "amber" | "blue" | "green" | "grey";
export type Chip = { label: string; tone: Tone };
export type QueueItem = {
  /** Konuşma kimliği: bir müşteri listede yalnızca bir kez görünür. */
  id: string;
  customer: Customer;
  /** En eski bekleyen kaynağın zamanı. */
  since: string;
  chips: Chip[];
  summary: string;
};

/** Ekibe iletilen talebin rengi: acil ve şikayet kırmızı, işlem gerektirenler turuncu. */
const FORWARDED_TONES: Record<string, Tone> = {
  complaint: "red",
  verify_locked: "red",
  team_overdue: "red",
};
const HANDOFF_TONES: Record<string, Tone> = { customer_request: "red", complaint: "red" };

const earliest = (a: string | undefined, b: string) => (a === undefined || b < a ? b : a);

/**
 * Üç kaynağı konuşmaya göre birleştirir; en uzun bekleyen üstte. Aynı müşteri hem soru hem talep
 * hem devir olarak görünüyorsa tek satırdır, hepsinin etiketi yan yana gelir.
 */
export function buildQueue(input: { questions: Question[]; forwarded: Forwarded[]; handedOff: ConversationRow[] }): QueueItem[] {
  const items = new Map<string, QueueItem & { handoff?: string; talep?: string; soru?: string }>();
  const touch = (id: string, customer: Customer, since: string) => {
    const item = items.get(id) ?? { id, customer, since, chips: [], summary: "" };
    item.since = earliest(item.since, since);
    items.set(id, item);
    return item;
  };
  const addChip = (item: QueueItem, chip: Chip) => {
    if (!item.chips.some((c) => c.label === chip.label)) item.chips.push(chip);
  };

  for (const c of input.handedOff) {
    const handoff = c.openHandoff;
    const awaiting = c.status === "human" && c.lastMessage?.sender === "customer";
    const item = touch(c.id, c.customer, handoff?.createdAt ?? c.lastMessage?.createdAt ?? c.updatedAt);
    if (handoff) {
      addChip(item, { label: HANDOFF_REASONS[handoff.reason] ?? handoff.reason, tone: HANDOFF_TONES[handoff.reason] ?? "amber" });
      item.handoff = handoff.summary;
    }
    if (awaiting) {
      addChip(item, { label: "Cevap bekliyor", tone: "red" });
      if (c.lastMessage) item.since = earliest(item.since, c.lastMessage.createdAt);
      item.handoff ??= preview(c.lastMessage);
    }
    if (c.status === "human" && c.assignedTo) addChip(item, { label: `Ekipte: ${c.assignedTo.name}`, tone: "green" });
  }
  for (const n of input.forwarded) {
    const item = touch(n.conversationId, n.customer, n.createdAt);
    addChip(item, { label: n.label, tone: FORWARDED_TONES[n.kind] ?? "amber" });
    item.talep ??= n.issues[0] ?? n.question;
  }
  for (const q of input.questions) {
    const item = touch(q.conversationId, q.customer, q.createdAt);
    addChip(item, { label: "Lina soruyor", tone: "blue" });
    item.soru ??= q.question;
  }

  return [...items.values()]
    .map(({ handoff, talep, soru, ...item }) => ({ ...item, summary: handoff || talep || soru || "" }))
    .sort((a, b) => a.since.localeCompare(b.since));
}

/** Paneli açık tutan ekip yeni işleri kaçırmasın: yenileme sıklığı. */
export const REFRESH_MS = 20_000;

/** Liste ya da konuşma: ilk açılışta, 20 saniyede bir, pencereye dönünce ve sunucudan canlı olay gelince yenilenir. */
export function useLive(load: () => Promise<void>, deps: unknown[]) {
  useEffect(() => {
    void load();
    const refresh = () => void load();
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener(LIVE_EVENT, refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(LIVE_EVENT, refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
