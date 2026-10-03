import { useEffect, useRef, useState } from "react";
import { api, type Membership } from "../api";
import { Link } from "../router";

type Status = "bot" | "waiting" | "human";
type Person = { id: string; name: string };
type Handoff = { reason: string; summary: string; createdAt: string };

export type ConversationRow = {
  id: string;
  status: Status;
  updatedAt: string;
  customer: { name: string; phone: string };
  assignedTo: Person | null;
  openHandoff: Handoff | null;
  lastMessage: { sender: string; type: string; text: string | null; createdAt: string } | null;
};

type Message = {
  id: string;
  sender: "customer" | "bot" | "agent" | "system";
  type: string;
  text: string | null;
  createdAt: string;
  author: { name: string } | null;
  hasImage: boolean;
  sendError: string | null;
};

type Detail = {
  conversation: { id: string; status: Status; assignedTo: Person | null };
  customer: { name: string; phone: string };
  messages: Message[];
  expertCalls: { agent: string; question: string | null; answer: string | null; createdAt: string }[];
  handoffs: (Handoff & { status: "open" | "resolved" })[];
  notifications: { id: string; label: string; important: boolean; status: "open" | "done"; orderNames: string[]; issues: string[] }[];
};

/** Paneli açık tutan ekip yeni mesajları kaçırmasın: liste ve konuşma bu sıklıkla yenilenir. */
const REFRESH_MS = 20_000;

export const HANDOFF_REASONS: Record<string, string> = {
  customer_request: "Temsilci istedi",
  complaint: "Şikayet",
  return_or_cancel: "İade ya da iptal",
  unknown_answer: "Cevabı bilinmiyor",
  other: "Diğer",
};
const AGENT_LABELS: Record<string, string> = { order: "Sipariş uzmanı", returns: "İade uzmanı", knowledge: "Mağaza bilgi uzmanı" };
/** Yazı ve fotoğraf dışındaki mesajların içeriği saklanmaz; ne olduğu yazılır. */
const TYPE_LABELS: Record<string, string> = { audio: "Ses mesajı", video: "Video", document: "Belge", location: "Konum", contacts: "Kişi kartı" };

export const statusLabel = (c: { status: Status; assignedTo: Person | null }) =>
  c.status === "human" ? `Ekipte${c.assignedTo ? `: ${c.assignedTo.name}` : ""}` : c.status === "waiting" ? "Ekibi bekliyor" : "Lina cevaplıyor";

const time = (iso: string) => new Date(iso).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const preview = (m: ConversationRow["lastMessage"]) => {
  if (!m) return "";
  // Ekibin Lina'ya cevabı iç bilgidir; müşteriye giden bir mesaj gibi görünmesin.
  if (m.type === "team_answer") return "Ekip Lina’nın sorusunu cevapladı";
  const who = m.sender === "customer" ? "Müşteri" : m.sender === "agent" ? "Ekip" : "Lina";
  return `${who}: ${m.text?.trim() || (m.type === "image" ? "Fotoğraf" : (TYPE_LABELS[m.type] ?? "Mesaj"))}`;
};

function useRefresh(load: () => Promise<void>, deps: unknown[]) {
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, deps);
}

/** Tüm sohbetler: en son hareket eden üstte (docs/panel.md "Sohbetler"). */
export function ConversationsPage({ store }: { store: Membership }) {
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [older, setOlder] = useState<ConversationRow[]>([]);
  const [more, setMore] = useState(true);
  const [error, setError] = useState("");
  const base = `/tenants/${store.tenantId}/conversations`;

  useRefresh(async () => {
    try {
      const list = (await api<{ conversations: ConversationRow[] }>(`${base}?view=all`)).conversations;
      setRows(list);
      if (list.length < 50) setMore(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Sohbetler yüklenemedi"); }
  }, [store.tenantId]);

  // Yenilenen ilk sayfa ile önceden yüklenen eski sayfalar çakışmasın.
  const all = [...(rows ?? []), ...older.filter((o) => !rows?.some((r) => r.id === o.id))];
  async function loadOlder() {
    const last = all.at(-1);
    if (!last) return;
    try {
      const list = (await api<{ conversations: ConversationRow[] }>(`${base}?view=all&before=${encodeURIComponent(last.updatedAt)}`)).conversations;
      setOlder((o) => [...o, ...list]);
      if (list.length < 50) setMore(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Sohbetler yüklenemedi"); }
  }

  return <main className="page conversations-page">
    <div className="test-heading"><div><p className="hint">{store.name}</p><h1>Tüm sohbetler</h1></div></div>
    {error && <p role="alert" className="test-error">{error}</p>}
    {rows === null && !error && <p className="hint" role="status">Yükleniyor…</p>}
    {rows?.length === 0 && <p className="hint">Henüz WhatsApp konuşması yok. Müşteriler yazdıkça burada görünecek.</p>}
    <ul className="conversation-list">
      {all.map((c) => <li key={c.id}>
        <Link className="panel-card conversation-row" to={`/m/${store.slug}/sohbetler/${c.id}`}>
          <span className="conversation-who"><strong>{c.customer.name}</strong> <span className="hint">{c.customer.phone}</span></span>
          <span className={`conversation-status ${c.status}`}>{statusLabel(c)}</span>
          <span className="conversation-preview">{preview(c.lastMessage)}</span>
          <span className="hint">{time(c.lastMessage?.createdAt ?? c.updatedAt)}</span>
        </Link>
      </li>)}
    </ul>
    {more && all.length > 0 && <button className="btn btn-secondary" onClick={() => void loadOlder()}>Daha eski sohbetler</button>}
  </main>;
}

/** Bir konuşma: mesajlar, Lina'nın uzmanlara sordukları ve ekibe düşenler. Bu adımda yalnızca okunur. */
export function ConversationPage({ store, conversationId }: { store: Membership; conversationId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const thread = useRef<HTMLElement>(null);
  // Konuşma en yeni mesajdan açılır; yeni mesaj gelince de aşağı iner.
  const lastId = detail?.messages.at(-1)?.id;
  useEffect(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight; }, [lastId]);

  useRefresh(async () => {
    try { setDetail(await api<Detail>(`/tenants/${store.tenantId}/conversations/${conversationId}`)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Konuşma yüklenemedi"); }
  }, [store.tenantId, conversationId]);

  const openHandoff = detail?.handoffs.find((h) => h.status === "open");
  const forwarded = detail?.notifications.filter((n) => n.status === "open" && n.important) ?? [];
  return <main className="page conversation-page">
    <p><Link to={`/m/${store.slug}/sohbetler`}>← Tüm sohbetler</Link></p>
    {error && <p role="alert" className="test-error">{error}</p>}
    {!detail && !error && <p className="hint" role="status">Yükleniyor…</p>}
    {detail && <>
      <div className="test-heading"><div><p className="hint">{detail.customer.phone}</p><h1>{detail.customer.name}</h1></div>
        <span className={`conversation-status ${detail.conversation.status}`}>{statusLabel(detail.conversation)}</span></div>
      <div className="test-layout">
        <section ref={thread} className="panel-card conversation-messages" aria-label="Mesajlar">
          {detail.messages.length === 0 && <p className="hint">Bu konuşmada mesaj yok.</p>}
          {detail.messages.map((m) => <ChatMessage key={m.id} m={m} tenantId={store.tenantId} />)}
        </section>
        <aside className="panel-card test-details">
          <h2>Durum</h2>
          <p>{statusLabel(detail.conversation)}</p>
          <p className="hint">Bu ekrandan devralma ve müşteriye yazma bir sonraki adımda eklenecek.</p>
          {openHandoff && <>
            <h2>Lina devretti</h2>
            <p><strong>{HANDOFF_REASONS[openHandoff.reason] ?? openHandoff.reason}</strong> · <span className="hint">{time(openHandoff.createdAt)}</span></p>
            <p className="conversation-summary">{openHandoff.summary}</p>
          </>}
          {forwarded.length > 0 && <>
            <h2>Ekibe iletilenler</h2>
            {forwarded.map((n) => <div key={n.id}>
              <p><strong>{n.label}</strong>{n.orderNames.length > 0 && ` (${n.orderNames.join(", ")})`}</p>
              {n.issues.length > 0 && <ul>{n.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
            </div>)}
          </>}
          <h2>Lina’nın uzmanlara sordukları</h2>
          {detail.expertCalls.length === 0 && <p className="hint">Bu konuşmada uzmana soru sorulmadı.</p>}
          {detail.expertCalls.map((r, i) => <details key={i}><summary>{AGENT_LABELS[r.agent] ?? r.agent} · {time(r.createdAt)}</summary><p>{r.question}</p><p>{r.answer}</p></details>)}
        </aside>
      </div>
    </>}
  </main>;
}

function ChatMessage({ m, tenantId }: { m: Message; tenantId: string }) {
  // İç kayıtlar müşteriye gitmez: devralma notları ve ekibin Lina'ya cevabı.
  if (m.type === "note") return <p className="conversation-note">{m.text} · {time(m.createdAt)}</p>;
  if (m.type === "team_answer") return <p className="conversation-note">Ekibin Lina’ya cevabı (müşteri görmez) · {time(m.createdAt)}<br />{m.text}</p>;
  const who = m.sender === "customer" ? "Müşteri" : m.sender === "agent" ? `Ekip${m.author ? ` (${m.author.name})` : ""}` : m.sender === "system" ? "Lina (hazır metin)" : "Lina";
  return <div className={`chat-bubble${m.sender === "customer" ? "" : " ours"}`}>
    <span>{who} · {time(m.createdAt)}</span>
    {m.hasImage && <img className="conversation-image" src={`/api/tenants/${tenantId}/media/${m.id}`} alt="Müşterinin gönderdiği fotoğraf" />}
    {m.text ? <p>{m.text}</p> : !m.hasImage && <p className="hint">{m.type === "image" ? "Fotoğraf (saklanamadı)" : (TYPE_LABELS[m.type] ?? "Desteklenmeyen mesaj")}</p>}
    {m.sendError && <p role="alert" className="test-error">Müşteriye gönderilemedi: {m.sendError}</p>}
  </div>;
}
