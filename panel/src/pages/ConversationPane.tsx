import { useEffect, useRef, useState } from "react";
import { api, waitingChanged, type Membership } from "../api";
import { UserIcon } from "../icons";
import { Link } from "../router";
import {
  ago, clock, dateTime, dayOf, HANDOFF_REASONS, initials, statusLabel, TYPE_LABELS, useLive,
  type Customer, type Handoff, type Person, type Status,
} from "./inbox-shared";

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

type OpenQuestion = { id: string; question: string; context: string; customerMessage: string | null; createdAt: string };
type ForwardedLite = { id: string; kind: string; label: string; important: boolean; status: "open" | "done"; orderNames: string[]; issues: string[]; question: string; answer: string; updatedAt: string | null };

type Detail = {
  /** canReply: konuşma bende ve WhatsApp'ın 24 saatlik yazma süresi açık. */
  conversation: { id: string; status: Status; assignedTo: Person | null; canReply: boolean; windowOpenUntil: string | null };
  customer: Customer & { firstSeenAt?: string };
  messages: Message[];
  expertCalls: { agent: string; question: string | null; answer: string | null; createdAt: string }[];
  handoffs: (Handoff & { status: "open" | "resolved" })[];
  notifications: ForwardedLite[];
  /** Lina'nın ekibe sorduğu, cevabı beklenen sorular. */
  teamQuestions: OpenQuestion[];
};

const AGENT_LABELS: Record<string, string> = { order: "Sipariş uzmanı", returns: "İade uzmanı", knowledge: "Mağaza bilgi uzmanı" };

/** WhatsApp, müşterinin son mesajından 24 saat sonra serbest mesaja izin vermez: kalan süre. */
function windowLeft(until: string | null, now = Date.now()) {
  if (!until) return null;
  const minutes = Math.floor((new Date(until).getTime() - now) / 60_000);
  if (minutes <= 0) return null;
  return minutes < 60 ? `${minutes} dk` : `${Math.floor(minutes / 60)} sa`;
}

/**
 * Konuşma (orta bölme) ve müşteri kartı (sağ bölme). Ekip konuşmayı devralır (Lina susar), müşteriye yazar
 * ve işi bitince Lina'ya geri verir; Lina'nın ekibe sorduğu soruları burada cevaplar, ekibe iletilen talepleri
 * "Tamamlandı" yapar (docs/panel.md "Sohbetler").
 */
export function ConversationPane({ store, conversationId, userId, backTo }: { store: Membership; conversationId: string; userId: string; backTo: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [justDone, setJustDone] = useState<ForwardedLite | null>(null);
  const [draft, setDraft] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [teach, setTeach] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCard, setShowCard] = useState(false);
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
  useLive(load, [store.tenantId, conversationId]);

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

  async function answer(q: OpenQuestion) {
    const text = (answers[q.id] ?? "").trim();
    if (!text) return;
    setSending(q.id); setError(""); setNotice(""); setJustDone(null);
    try {
      const res = await api<{ taught: boolean; teachSkipped?: "specific" | "long" | "limit"; windowClosed: boolean; relay: "lina" | "in_team" | "bot_off" }>(
        `${tenant}/team-questions/${q.id}/answer`, { method: "POST", body: { answer: text, teach: Boolean(teach[q.id]) } });
      const taught = res.taught
        ? " Bu bilgi Lina'ya da öğretildi."
        : res.teachSkipped === "specific"
          ? " Lina'ya öğretilmedi: soru ya da cevapta sipariş numarası ya da telefon var, bu tek müşteriye özel bir bilgi. Genel bir kural için Ayarlar'dan ders yazın."
          : res.teachSkipped === "long"
            ? " Lina'ya öğretilmedi: soru ve cevap ders olmak için çok uzun (en fazla 1000 karakter)."
            : res.teachSkipped === "limit"
              ? " Lina'ya öğretilmedi: ders sınırı doldu (en fazla 200); önce eski dersleri silin."
              : "";
      setNotice(
        res.relay === "in_team"
          ? `Cevap kaydedildi ama konuşma ekipte, Lina müşteriye iletmeyecek. Müşteriye konuşmadan siz yazın ya da konuşmayı Lina'ya geri verin; geri verince Lina iletir.${taught}`
          : res.relay === "bot_off"
            ? `Cevap kaydedildi ama Lina şu an kapalı, müşteriye iletilmedi.${taught}`
            : res.windowClosed
              ? `Cevap kaydedildi, ama müşterinin son mesajı 24 saatten eski; WhatsApp kuralları gereği mesaj gönderilemeyebilir.${taught}`
              : `Lina cevabınızı müşteriye iletiyor.${taught}`,
      );
      setAnswers((a) => ({ ...a, [q.id]: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cevap gönderilemedi");
    } finally {
      setSending(null);
      await load();
      waitingChanged();
    }
  }

  async function complete(n: ForwardedLite) {
    setNotice(""); setJustDone(null);
    // Ekranda görülen hâl gönderilir: bu arada müşteri yeni bir şey yazdıysa sunucu kapatmaz.
    if (await act(`${tenant}/notifications/${n.id}/done`, { seenUpdatedAt: n.updatedAt ?? null })) setJustDone(n);
  }
  async function reopen(n: ForwardedLite) {
    setJustDone(null);
    if (await act(`${tenant}/notifications/${n.id}/reopen`)) setNotice("Talep yeniden açıldı.");
  }

  const c = detail?.conversation;
  const mine = c?.status === "human" && c.assignedTo?.id === userId;
  const isOwner = store.role === "owner";
  // Başkasının devraldığını yalnızca mağaza sahibi alabilir ve geri verebilir; devralan kişi silinmişse herkes alabilir.
  const canTakeOver = c && !mine && (c.status !== "human" || isOwner || !c.assignedTo);
  const canRelease = c && (mine || c.status === "waiting" || (c.status === "human" && (isOwner || !c.assignedTo)));
  const openHandoff = detail?.handoffs.find((h) => h.status === "open");
  const pastHandoffs = detail?.handoffs.filter((h) => h.status === "resolved") ?? [];
  const forwarded = detail?.notifications.filter((n) => n.status === "open" && n.important) ?? [];
  const orderNames = [...new Set(detail?.notifications.flatMap((n) => n.orderNames) ?? [])];
  const left = windowLeft(c?.windowOpenUntil ?? null);

  const state = !c ? "" : [
    c.status === "human" ? (mine ? "Sizde · Lina susuyor" : `${statusLabel(c)} · Lina susuyor`) : c.status === "waiting" ? "Ekibi bekliyor · henüz kimse devralmadı" : "Lina cevaplıyor",
    left ? `24 saat penceresinde ${left} kaldı` : c.windowOpenUntil ? "WhatsApp yazma süresi doldu" : "",
  ].filter(Boolean).join(" · ");

  let lastDay = "";
  return <section className="cp" aria-label="Konuşma">
    <div className="cp-main">
      <header className="cp-head">
        <Link className="cp-back" to={backTo} aria-label="Listeye dön">←</Link>
        {detail ? <>
          <span className="avatar-md" aria-hidden="true">{initials(detail.customer.name)}</span>
          <div className="cp-title">
            <h2>{detail.customer.name}</h2>
            <p role="status">{state}</p>
          </div>
        </> : <div className="cp-title"><h2>Konuşma</h2></div>}
        <button type="button" className="icon-btn cp-card-toggle" aria-label="Müşteri kartı" aria-expanded={showCard} onClick={() => setShowCard((v) => !v)}><UserIcon /></button>
        <div className="cp-actions">
          {canRelease && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act(`${base}/release`)}>Lina’ya geri ver</button>}
          {canTakeOver && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(`${base}/takeover`)}>Devral</button>}
        </div>
      </header>

      <div className="cp-flow">
        <div className="cp-top">
        {(error || loadError) && <p role="alert" className="cp-alert">{error || loadError}</p>}
        {notice && <p className="cp-notice" role="status">{notice}</p>}
        {justDone && <p className="cp-notice" role="status">{justDone.label}: talep tamamlandı. <button type="button" className="link-button" onClick={() => void reopen(justDone)}>Geri al</button></p>}
        {!detail && !loadError && <p className="hint" role="status">Yükleniyor…</p>}

        {detail && (openHandoff || forwarded.length > 0) && <div className="cp-summary">
          <span className="cp-summary-tag">Lina’nın özeti</span>
          <div>
            {openHandoff && <p><strong>{HANDOFF_REASONS[openHandoff.reason] ?? openHandoff.reason}</strong> · {openHandoff.summary}</p>}
            {forwarded.map((n) => <div key={n.id} className="cp-forwarded">
              <p><strong>{n.label}</strong>{n.orderNames.length > 0 && ` (${n.orderNames.join(", ")})`}</p>
              {n.issues.length > 0 && <ul>{n.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} aria-label={`Tamamlandı: ${n.label}`} onClick={() => void complete(n)}>Tamamlandı</button>
            </div>)}
          </div>
        </div>}

        {detail?.teamQuestions.map((q) => <article key={q.id} className="cp-ask" aria-label="Lina’nın sorusu">
          <header><span className="chip chip-blue">Lina soruyor</span><span className="hint">{ago(q.createdAt)}</span></header>
          {q.customerMessage && <p><span className="label">Müşteri:</span> {q.customerMessage}</p>}
          <p className="cp-ask-q">{q.question}</p>
          {q.context && <p className="hint"><span className="label">Bağlam:</span> {q.context}</p>}
          <p className="hint">Kısa bir cevap yazın; Lina müşteriye kendi cümleleriyle iletir. Müşteri sizinle konuştuğunuzu bilmez.</p>
          <label className="sr-only" htmlFor={`answer-${q.id}`}>Cevabınız</label>
          <textarea id={`answer-${q.id}`} rows={2} maxLength={2000} placeholder="Kısa cevabınız…" value={answers[q.id] ?? ""}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
          <div className="cp-ask-actions">
            {isOwner ? <label className="check"><input type="checkbox" checked={Boolean(teach[q.id])} onChange={(e) => setTeach((t) => ({ ...t, [q.id]: e.target.checked }))} /> Lina’ya öğret (bir daha sormasın)</label> : <span />}
            <button type="button" className="btn btn-primary" disabled={sending === q.id || !(answers[q.id] ?? "").trim()} onClick={() => void answer(q)}>
              {sending === q.id ? "Gönderiliyor…" : "Cevabı gönder"}
            </button>
          </div>
        </article>)}
        </div>

        {detail && <section ref={thread} className="cp-thread" aria-label="Mesajlar" role="log" tabIndex={0}
          onScroll={(e) => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {detail.messages.length === 0 && <p className="hint">Bu konuşmada mesaj yok.</p>}
          {detail.messages.length >= 200 && <p className="note">Yalnızca son 200 mesaj gösteriliyor.</p>}
          {detail.messages.map((m) => {
            const day = dayOf(m.createdAt);
            const separator = day !== lastDay ? <p key={`d-${m.id}`} className="note day">{day}</p> : null;
            lastDay = day;
            return <div key={m.id} className="cp-row">{separator}<ChatMessage m={m} tenantId={store.tenantId} onImageLoad={toBottom} /></div>;
          })}
        </section>}
      </div>

      {detail && <footer className="cp-compose">
        {mine && c!.canReply && <>
          <label className="sr-only" htmlFor="reply">Müşteriye mesajınız</label>
          <textarea id="reply" rows={2} maxLength={4000} placeholder="Müşteriye yazın… Mesaj mağaza adına, imzasız gider." value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <button type="button" className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void send()}>Gönder</button>
        </>}
        {mine && !c!.canReply && <p className="cp-closed">Müşterinin son mesajından 24 saat geçti. WhatsApp kuralı gereği müşteri yeniden yazana kadar mesaj gönderilemez.</p>}
        {!mine && <>
          <label className="sr-only" htmlFor="reply-locked">Müşteriye mesajınız</label>
          <textarea id="reply-locked" rows={2} disabled placeholder={c!.status === "human" ? "Konuşma başkasında; yalnızca devralan kişi yazabilir." : "Önce devralın, sonra yazın…"} value="" readOnly />
          <button type="button" className="btn btn-primary" disabled>Gönder</button>
        </>}
        {!mine && draft.trim() && <p className="cp-closed">Konuşma artık sizde değil; yazdığınız mesaj gönderilmedi: “{draft.trim()}”</p>}
      </footer>}
    </div>

    <aside className={`cp-card${showCard ? " open" : ""}`} aria-label="Müşteri kartı">
      {detail && <>
        <section>
          <h3>Müşteri</h3>
          <p className="cc-name">{detail.customer.name}</p>
          {detail.customer.name !== detail.customer.phone && <p className="cc-phone">{detail.customer.phone}</p>}
          {detail.customer.firstSeenAt && <p className="hint">İlk mesaj: {dayOf(detail.customer.firstSeenAt)}</p>}
        </section>
        <section>
          <h3>Siparişler</h3>
          {orderNames.length === 0
            ? <p className="hint">Lina bu konuşmada henüz bir siparişe bakmadı.</p>
            : <p className="cc-orders">{orderNames.map((o) => <span key={o} className="chip chip-grey">{o}</span>)}</p>}
        </section>
        <section>
          <h3>Lina’nın uzmanlara sordukları</h3>
          {detail.expertCalls.length === 0 && <p className="hint">Bu konuşmada uzmana soru sorulmadı.</p>}
          {detail.expertCalls.map((r, i) => <details key={i}><summary>{AGENT_LABELS[r.agent] ?? r.agent} · {dateTime(r.createdAt)}</summary><p>{r.question}</p><p>{r.answer}</p></details>)}
        </section>
        {pastHandoffs.length > 0 && <section>
          <h3>Önceki devirler</h3>
          {pastHandoffs.map((h, i) => <p key={i} className="hint">{dateTime(h.createdAt)} · {HANDOFF_REASONS[h.reason] ?? h.reason}</p>)}
        </section>}
      </>}
    </aside>
  </section>;
}

function ChatMessage({ m, tenantId, onImageLoad }: { m: Message; tenantId: string; onImageLoad: () => void }) {
  // İç kayıtlar müşteriye gitmez: devralma notları ve ekibin Lina'ya cevabı.
  if (m.type === "note") return <p className="note">{m.text} · {clock(m.createdAt)}</p>;
  if (m.type === "team_answer") return <p className="note">Ekibin Lina’ya cevabı (müşteri görmez) · {clock(m.createdAt)}<br />{m.text}</p>;
  const ours = m.sender !== "customer";
  const who = m.sender === "agent" ? `Ekip${m.author ? ` (${m.author.name})` : ""}` : m.sender === "system" ? "Lina (hazır metin)" : m.sender === "bot" ? "Lina" : "";
  return <div className={`bubble${ours ? " ours" : ""}${m.sender === "agent" ? " agent" : ""}`}>
    {who && <span className="bubble-who">{who}</span>}
    {m.hasImage && <img className="bubble-image" src={`/api/tenants/${tenantId}/media/${m.id}`} alt="Müşterinin gönderdiği fotoğraf" onLoad={onImageLoad} />}
    {m.text ? <p>{m.type === "audio" && <span className="hint">Sesli mesaj, yazıya çevrildi: </span>}{m.text}</p> : !m.hasImage && <p className="hint">{m.type === "image" ? "Fotoğraf (saklanamadı)" : (TYPE_LABELS[m.type] ?? "Desteklenmeyen mesaj")}</p>}
    {m.sendError && <p role="alert" className="bubble-error">Müşteriye gönderilemedi. Mesajı yeniden yazıp gönderin.</p>}
    <time dateTime={m.createdAt}>{clock(m.createdAt)}</time>
  </div>;
}
