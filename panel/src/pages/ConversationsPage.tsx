import { useEffect, useRef, useState } from "react";
import { api, waitingChanged, type Membership } from "../api";
import { Link, useLocation } from "../router";

type Status = "bot" | "waiting" | "human";
type Person = { id: string; name: string };
type Handoff = { reason: string; summary: string; createdAt: string };
type Customer = { name: string; phone: string };

export type ConversationRow = {
  id: string;
  status: Status;
  updatedAt: string;
  customer: Customer;
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

type Forwarded = { id: string; label: string; important: boolean; status: "open" | "done"; orderNames: string[]; issues: string[]; updatedAt: string | null };

type Detail = {
  /** canReply: konuşma bende ve WhatsApp'ın 24 saatlik yazma süresi açık. */
  conversation: { id: string; status: Status; assignedTo: Person | null; canReply: boolean };
  customer: Customer;
  messages: Message[];
  expertCalls: { agent: string; question: string | null; answer: string | null; createdAt: string }[];
  handoffs: (Handoff & { status: "open" | "resolved" })[];
  notifications: Forwarded[];
  /** Lina'nın ekibe sorduğu, cevabı beklenen sorular. */
  teamQuestions: { id: string; question: string; createdAt: string }[];
};

/** Paneli açık tutan ekip yeni mesajları kaçırmasın: liste ve konuşma bu sıklıkla yenilenir. */
const REFRESH_MS = 20_000;
/** Sunucunun bir sayfada döndürdüğü konuşma sayısı. */
const PAGE_SIZE = 50;

export const HANDOFF_REASONS: Record<string, string> = {
  customer_request: "Temsilci istedi",
  complaint: "Şikayet",
  return_or_cancel: "İade ya da iptal",
  unknown_answer: "Cevabı bilinmiyor",
  other: "Diğer",
};
const AGENT_LABELS: Record<string, string> = { order: "Sipariş uzmanı", returns: "İade uzmanı", knowledge: "Mağaza bilgi uzmanı" };
/** Yazı ve fotoğraf dışındaki mesajların içeriği saklanmaz; ne olduğu yazılır. */
const TYPE_LABELS: Record<string, string> = {
  audio: "Ses mesajı", video: "Video", document: "Belge", location: "Konum", contacts: "Kişi kartı",
  reaction: "Tepki", sticker: "Çıkartma", button: "Buton yanıtı", interactive: "Etkileşimli mesaj",
};

export const statusLabel = (c: { status: Status; assignedTo: Person | null }) =>
  c.status === "human" ? `Ekipte${c.assignedTo ? `: ${c.assignedTo.name}` : ""}` : c.status === "waiting" ? "Ekibi bekliyor" : "Lina cevaplıyor";

/** Müşterinin adı ve telefonu; adı yoksa ad yerine telefon gelir, o zaman telefon ikinci kez yazılmaz. */
export function Who({ customer }: { customer: Customer }) {
  return <><strong>{customer.name}</strong>{customer.name !== customer.phone && <> <span className="hint">{customer.phone}</span></>}</>;
}

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

const VIEWS = [
  { key: "all", label: "Tümü" },
  { key: "waiting", label: "Ekibi bekleyen" },
  { key: "mine", label: "Bende" },
] as const;
type View = (typeof VIEWS)[number]["key"];

/** Sohbetler: tümü (en son hareket eden üstte), ekibi bekleyenler ve benim devraldıklarım (docs/panel.md "Sohbetler"). */
export function ConversationsPage({ store }: { store: Membership }) {
  const [view, setView] = useState<View>("all");
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  /** Yüklenen bütün konuşmalar: ilk sayfa yenilendikçe güncellenir, eski sayfalar eklenir. */
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Eski sayfalar yüklendiyse yenilenen ilk sayfa listenin yerine geçmez, içine karışır. */
  const olderLoaded = useRef(false);
  const [error, setError] = useState("");
  const base = `/tenants/${store.tenantId}/conversations?view=${view}${query ? `&q=${encodeURIComponent(query)}` : ""}`;

  // Yazarken her tuşta sunucuya gitmesin.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  /** Aynı konuşma iki sayfada da gelebilir: yenisi geçerlidir; liste en son hareket edene göre sıralanır. */
  const merge = (current: ConversationRow[] | null, incoming: ConversationRow[]) => {
    const byId = new Map((current ?? []).map((c) => [c.id, c]));
    for (const c of incoming) byId.set(c.id, c);
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  useEffect(() => { setRows(null); setMore(false); olderLoaded.current = false; }, [base]);
  useRefresh(async () => {
    try {
      const list = (await api<{ conversations: ConversationRow[] }>(base)).conversations;
      if (olderLoaded.current) setRows((current) => merge(current, list));
      else { setRows(list); setMore(view !== "waiting" && list.length === PAGE_SIZE); }
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Sohbetler yüklenemedi"); }
  }, [base]);

  async function loadOlder() {
    const last = rows?.at(-1);
    if (!last || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const list = (await api<{ conversations: ConversationRow[] }>(`${base}&before=${encodeURIComponent(last.updatedAt)}`)).conversations;
      olderLoaded.current = true;
      setRows((current) => merge(current, list));
      setMore(list.length === PAGE_SIZE);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Sohbetler yüklenemedi"); }
    finally { setLoadingOlder(false); }
  }

  const empty = query
    ? "Bu aramayla eşleşen konuşma yok."
    : view === "waiting" ? "Şu an ekibi bekleyen konuşma yok."
    : view === "mine" ? "Devraldığınız konuşma yok."
    : "Henüz WhatsApp konuşması yok. Müşteriler yazdıkça burada görünecek.";
  return <main className="page conversations-page">
    <div className="test-heading"><div><p className="hint">{store.name}</p><h1>Tüm sohbetler</h1></div></div>
    <div className="conversation-filters">
      <div role="group" aria-label="Görünüm">{VIEWS.map((v) =>
        <button key={v.key} className={`btn ${view === v.key ? "btn-primary" : "btn-secondary"}`} aria-pressed={view === v.key} onClick={() => setView(v.key)}>{v.label}</button>)}
      </div>
      {view !== "waiting" && <>
        <label className="sr-only" htmlFor="conversation-search">Müşteri ara</label>
        <input id="conversation-search" type="search" placeholder="Ad ya da telefonla ara…" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </>}
    </div>
    {error && <p role="alert" className="test-error">{error}</p>}
    {rows === null && !error && <p className="hint" role="status">Yükleniyor…</p>}
    {rows?.length === 0 && <p className="hint">{empty}</p>}
    <ul className="conversation-list">
      {rows?.map((c) => <li key={c.id}>
        <Link className="panel-card conversation-row" to={`/m/${store.slug}/sohbetler/${c.id}`}>
          <span className="conversation-who"><Who customer={c.customer} /></span>
          <span className={`conversation-status ${c.status}`}>{statusLabel(c)}</span>
          <span className="conversation-preview">{preview(c.lastMessage)}</span>
          <span className="hint">{time(c.lastMessage?.createdAt ?? c.updatedAt)}</span>
        </Link>
      </li>)}
    </ul>
    {more && (rows?.length ?? 0) > 0 && <button className="btn btn-secondary" disabled={loadingOlder} onClick={() => void loadOlder()}>Daha eski sohbetler</button>}
  </main>;
}

/**
 * Bir konuşma: mesajlar, Lina'nın uzmanlara sordukları ve ekibe düşenler. Ekip konuşmayı devralır (Lina
 * susar), müşteriye yazar ve işi bitince Lina'ya geri verir (docs/panel.md "Sohbetler").
 */
export function ConversationPage({ store, conversationId, userId }: { store: Membership; conversationId: string; userId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const { search } = useLocation();
  const fromWaiting = search.get("from") === "bekleyenler";
  const tenant = `/tenants/${store.tenantId}`;
  const base = `${tenant}/conversations/${conversationId}`;
  const thread = useRef<HTMLElement>(null);
  /** Kişi eski mesajları okuyorsa yeni mesaj gelince yerinden edilmez; en alttaysa yeni mesaja inilir. */
  const nearBottom = useRef(true);
  const lastId = detail?.messages.at(-1)?.id;
  const toBottom = () => { if (thread.current && nearBottom.current) thread.current.scrollTop = thread.current.scrollHeight; };
  useEffect(toBottom, [lastId]);

  const customerName = detail?.customer.name;
  useEffect(() => {
    if (customerName) document.title = [customerName, store.name, "Lina Panel"].join(" · ");
  }, [customerName, store.name]);

  async function load() {
    try { setDetail(await api<Detail>(base)); setLoadError(""); }
    catch (e) { setLoadError(e instanceof Error ? e.message : "Konuşma yüklenemedi"); }
  }
  useRefresh(load, [store.tenantId, conversationId]);

  /** Devral, geri ver, gönder, tamamla: sonuç ne olursa olsun konuşma yeniden yüklenir (başkası değiştirmiş olabilir). */
  async function act(path: string, body?: unknown) {
    setBusy(true); setError("");
    try { await api(path, { method: "POST", body }); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "İşlem yapılamadı"); return false; }
    finally { await load(); setBusy(false); waitingChanged(); }
  }
  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    nearBottom.current = true;
    // Gönderilirken yazılmaya devam edilen metin silinmesin: yalnızca gönderilen metin kutudan çıkar.
    if (await act(`${base}/messages`, { text })) setDraft((d) => (d.trim() === text ? "" : d));
  }

  const c = detail?.conversation;
  const mine = c?.status === "human" && c.assignedTo?.id === userId;
  const isOwner = store.role === "owner";
  // Başkasının devraldığını yalnızca mağaza sahibi alabilir ve geri verebilir; devralan kişi silinmişse herkes alabilir.
  const canTakeOver = c && !mine && (c.status !== "human" || isOwner || !c.assignedTo);
  const canRelease = c && (mine || c.status === "waiting" || (c.status === "human" && (isOwner || !c.assignedTo)));
  const openHandoff = detail?.handoffs.find((h) => h.status === "open");
  const forwarded = detail?.notifications.filter((n) => n.status === "open" && n.important) ?? [];
  return <main className="page conversation-page">
    <p>{fromWaiting
      ? <Link to={`/m/${store.slug}/bekleyenler`}>← Bekleyenler</Link>
      : <Link to={`/m/${store.slug}/sohbetler`}>← Tüm sohbetler</Link>}</p>
    {(error || loadError) && <p role="alert" className="test-error">{error || loadError}</p>}
    {!detail && !loadError && <p className="hint" role="status">Yükleniyor…</p>}
    {detail && <>
      <div className="test-heading conversation-heading">
        <div><h1>{detail.customer.name}</h1>{detail.customer.name !== detail.customer.phone && <p className="hint">{detail.customer.phone}</p>}</div>
        <div className="conversation-actions">
          <span className={`conversation-status ${detail.conversation.status}`} role="status">{statusLabel(detail.conversation)}</span>
          {canTakeOver && <button className="btn btn-primary" disabled={busy} onClick={() => void act(`${base}/takeover`)}>Devral</button>}
          {canRelease && <button className="btn btn-secondary" disabled={busy} onClick={() => void act(`${base}/release`)}>Lina’ya geri ver</button>}
        </div>
      </div>
      <p className="hint conversation-state">
        {mine && "Konuşma sizde: Lina bu müşteriye cevap vermiyor. İşiniz bitince Lina’ya geri verin."}
        {!mine && detail.conversation.status === "human" && `Lina bu konuşmada susuyor.${isOwner || !detail.conversation.assignedTo ? "" : " Yalnızca devralan kişi yazabilir."}`}
        {detail.conversation.status === "waiting" && "Lina bu konuşmayı ekibe devretti. Siz devralana kadar basit sorulara cevap vermeye devam eder; devralınca susar ve müşteriye siz yazarsınız."}
        {detail.conversation.status === "bot" && "Müşteriye Lina cevap veriyor. Devralırsanız Lina susar ve müşteriye siz yazarsınız."}
      </p>
      <div className="test-layout">
        <div className="panel-card test-chat">
          <section ref={thread} className="conversation-messages" aria-label="Mesajlar" role="log" tabIndex={0}
            onScroll={(e) => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
            {detail.messages.length === 0 && <p className="hint">Bu konuşmada mesaj yok.</p>}
            {detail.messages.length >= 200 && <p className="conversation-note">Yalnızca son 200 mesaj gösteriliyor.</p>}
            {detail.messages.map((m) => <ChatMessage key={m.id} m={m} tenantId={store.tenantId} onImageLoad={toBottom} />)}
          </section>
          {mine && detail.conversation.canReply && <div className="test-compose">
            <label className="sr-only" htmlFor="reply">Müşteriye mesajınız</label>
            <textarea id="reply" rows={3} maxLength={4000} placeholder="Müşteriye yazın… Mesaj mağaza adına, imzasız gider." value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
            <button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void send()}>Gönder</button>
          </div>}
          {mine && !detail.conversation.canReply && <p className="conversation-closed">Müşterinin son mesajından 24 saat geçti. WhatsApp kuralı gereği müşteri yeniden yazana kadar mesaj gönderilemez.</p>}
          {!mine && draft.trim() && <p className="conversation-closed">Konuşma artık sizde değil; yazdığınız mesaj gönderilmedi: “{draft.trim()}”</p>}
        </div>
        <aside className="panel-card test-details">
          {detail.teamQuestions.length > 0 && <>
            <h2>Lina ekibe sordu</h2>
            {detail.teamQuestions.map((q) => <p key={q.id}>{q.question} <span className="hint">· {time(q.createdAt)}</span></p>)}
            <p><Link to={`/m/${store.slug}/bekleyenler`}>Bekleyenler’de cevapla</Link></p>
          </>}
          {openHandoff && <>
            <h2>Lina devretti</h2>
            <p><strong>{HANDOFF_REASONS[openHandoff.reason] ?? openHandoff.reason}</strong> · <span className="hint">{time(openHandoff.createdAt)}</span></p>
            <p className="conversation-summary">{openHandoff.summary}</p>
          </>}
          {forwarded.length > 0 && <>
            <h2>Ekibe iletilenler</h2>
            {forwarded.map((n) => <div key={n.id} className="conversation-forwarded">
              <p><strong>{n.label}</strong>{n.orderNames.length > 0 && ` (${n.orderNames.join(", ")})`}</p>
              {n.issues.length > 0 && <ul>{n.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
              <button className="btn btn-secondary" disabled={busy} aria-label={`Tamamlandı: ${n.label}`}
                onClick={() => void act(`${tenant}/notifications/${n.id}/done`, { seenUpdatedAt: n.updatedAt ?? null })}>Tamamlandı</button>
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

function ChatMessage({ m, tenantId, onImageLoad }: { m: Message; tenantId: string; onImageLoad: () => void }) {
  // İç kayıtlar müşteriye gitmez: devralma notları ve ekibin Lina'ya cevabı.
  if (m.type === "note") return <p className="conversation-note">{m.text} · {time(m.createdAt)}</p>;
  if (m.type === "team_answer") return <p className="conversation-note">Ekibin Lina’ya cevabı (müşteri görmez) · {time(m.createdAt)}<br />{m.text}</p>;
  const who = m.sender === "customer" ? "Müşteri" : m.sender === "agent" ? `Ekip${m.author ? ` (${m.author.name})` : ""}` : m.sender === "system" ? "Lina (hazır metin)" : "Lina";
  return <div className={`chat-bubble${m.sender === "customer" ? "" : " ours"}`}>
    <span>{who} · {time(m.createdAt)}</span>
    {m.hasImage && <img className="conversation-image" src={`/api/tenants/${tenantId}/media/${m.id}`} alt="Müşterinin gönderdiği fotoğraf" onLoad={onImageLoad} />}
    {m.text ? <p>{m.type === "audio" && <span className="hint">Sesli mesaj, yazıya çevrildi: </span>}{m.text}</p> : !m.hasImage && <p className="hint">{m.type === "image" ? "Fotoğraf (saklanamadı)" : (TYPE_LABELS[m.type] ?? "Desteklenmeyen mesaj")}</p>}
    {m.sendError && <p role="alert" className="test-error">Müşteriye gönderilemedi. Mesajı yeniden yazıp gönderin.</p>}
  </div>;
}
