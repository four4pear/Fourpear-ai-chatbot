import { useEffect, useState } from "react";
import { api, waitingChanged, type Membership } from "../api";
import { Link } from "../router";
import { HANDOFF_REASONS, statusLabel, Who, type ConversationRow } from "./ConversationsPage";

type Question = {
  id: string;
  conversationId: string;
  customer: { name: string; phone: string };
  question: string;
  context: string;
  customerMessage: string | null;
  status: "open" | "answered";
  answer: string | null;
  answeredBy: { name: string } | null;
  answeredAt: string | null;
  createdAt: string;
};

/** Ekibe iletilen talep: Lina'nın çözemeyip ekibe bıraktığı önemli bildirim (şikayet, iade kararı, iptal, gecikme…). */
type Forwarded = {
  id: string;
  conversationId: string;
  customer: { name: string; phone: string };
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

/** Paneli açık tutan ekip yeni soruları kaçırmasın: liste bu sıklıkla yenilenir. */
const REFRESH_MS = 20_000;

const timeAgo = (iso: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "az önce";
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} sa önce` : `${Math.round(hours / 24)} gün önce`;
};

/**
 * Bekleyenler: ekibin yapması gerekenler; her bölümde en uzun bekleyen üsttedir.
 * - "Lina soruyor": Lina'nın bilmediği ve arka planda ekibe sorduğu sorular. Ekip kısa bir cevap yazar;
 *   Lina müşteriye kendi cümleleriyle iletir.
 * - "Ekibe iletilenler": Lina'nın ekibe bıraktığı talepler (önemli bildirimler). Ekip işlemi yapıp tamamlar.
 * - "Devredilen konuşmalar": müşteri temsilci istedi ya da öfkesi sürdü; Lina konuşmayı ekibe devretti.
 */
export function WaitingPage({ store }: { store: Membership }) {
  const [open, setOpen] = useState<Question[] | null>(null);
  const [answered, setAnswered] = useState<Question[] | null>(null);
  const [showAnswered, setShowAnswered] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [teach, setTeach] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [forwarded, setForwarded] = useState<Forwarded[] | null>(null);
  const [done, setDone] = useState<Forwarded[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  /** Az önce tamamlanan talep: yanlışlıkla basıldıysa hemen geri alınabilsin. */
  const [justDone, setJustDone] = useState<Forwarded | null>(null);
  const [handedOff, setHandedOff] = useState<ConversationRow[] | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const tenant = `/tenants/${store.tenantId}`;
  const base = `${tenant}/team-questions`;
  const notifications = `${tenant}/notifications`;
  const isOwner = store.role === "owner";
  const chat = (conversationId: string) => `/m/${store.slug}/sohbetler/${conversationId}?from=bekleyenler`;

  /** Bölümler birbirinden bağımsız yüklenir: biri başarısız olsa da diğerleri görünür. */
  async function load() {
    const results = await Promise.allSettled([
      api<{ questions: Question[] }>(base).then((r) => setOpen(r.questions)),
      showAnswered ? api<{ questions: Question[] }>(`${base}?status=answered`).then((r) => setAnswered(r.questions)) : null,
      api<{ notifications: Forwarded[] }>(`${notifications}?filter=important`).then((r) => setForwarded(r.notifications)),
      showDone ? api<{ notifications: Forwarded[] }>(`${notifications}?filter=important&status=done`).then((r) => setDone(r.notifications)) : null,
      api<{ conversations: ConversationRow[] }>(`${tenant}/conversations?view=waiting`).then((r) => setHandedOff(r.conversations)),
    ]);
    waitingChanged();
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    setLoadError(failed ? (failed.reason instanceof Error ? failed.reason.message : "Bekleyenler yüklenemedi") : "");
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [store.tenantId, showAnswered, showDone]);

  async function send(q: Question) {
    const answer = (drafts[q.id] ?? "").trim();
    if (!answer) return;
    setSending(q.id); setError(""); setNotice(""); setJustDone(null);
    try {
      const res = await api<{ taught: boolean; windowClosed: boolean }>(`${base}/${q.id}/answer`, { method: "POST", body: { answer, teach: Boolean(teach[q.id]) } });
      setOpen((list) => list?.filter((x) => x.id !== q.id) ?? null);
      setNotice(
        res.windowClosed
          ? `${q.customer.name}: cevap kaydedildi, ama müşterinin son mesajı 24 saatten eski; WhatsApp kuralları gereği Lina mesaj gönderemeyebilir.`
          : `${q.customer.name}: Lina cevabınızı müşteriye iletiyor.${res.taught ? " Bu bilgi Lina'ya da öğretildi." : ""}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cevap gönderilemedi");
    } finally {
      setSending(null);
      void load();
    }
  }

  async function complete(n: Forwarded) {
    setError(""); setNotice(""); setJustDone(null);
    try {
      // Ekranda görülen hâl gönderilir: bu arada müşteri yeni bir şey yazdıysa sunucu kapatmaz.
      await api(`${notifications}/${n.id}/done`, { method: "POST", body: { seenUpdatedAt: n.updatedAt ?? null } });
      setForwarded((list) => list?.filter((x) => x.id !== n.id) ?? null);
      setJustDone(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tamamlanamadı");
    }
    void load();
  }

  async function reopen(n: Forwarded) {
    setError(""); setNotice(""); setJustDone(null);
    try {
      await api(`${notifications}/${n.id}/reopen`, { method: "POST" });
      setNotice(`${n.customer.name}: talep yeniden açıldı.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Geri alınamadı");
    }
    void load();
  }

  return <main className="page waiting-page">
    <div className="test-heading"><div><p className="hint">{store.name}</p><h1>Bekleyenler</h1></div></div>
    {notice && <p className="waiting-notice" role="status">{notice}</p>}
    {justDone && <p className="waiting-notice" role="status">{justDone.customer.name}: talep tamamlandı. <button className="link-button" onClick={() => void reopen(justDone)}>Geri al</button></p>}
    {(error || loadError) && <p role="alert" className="test-error">{error || loadError}</p>}

    <section aria-labelledby="lina-asks">
      <h2 id="lina-asks">Lina soruyor{open?.length ? ` (${open.length})` : ""}</h2>
      <p className="hint">Lina bilmediği konuları burada size soruyor. Kısa bir cevap yazın; Lina müşteriye kendi cümleleriyle iletir. Müşteri sizinle konuştuğunu bilmez.</p>
      {open === null && !loadError && <p className="hint" role="status">Yükleniyor…</p>}
      {open?.length === 0 && <p className="hint">Şu an Lina’nın sorusu yok.</p>}
      <div className="waiting-list">
        {open?.map((q) => <article key={q.id} className="panel-card waiting-card" aria-label={`${q.customer.name} için soru`}>
          <header><Who customer={q.customer} /> <span className="hint">· {timeAgo(q.createdAt)}</span></header>
          {q.customerMessage && <p><span className="waiting-label">Müşteri:</span> {q.customerMessage}</p>}
          <p className="waiting-question"><span className="waiting-label">Lina soruyor:</span> {q.question}</p>
          {q.context && <p className="hint"><span className="waiting-label">Bağlam:</span> {q.context}</p>}
          <label className="sr-only" htmlFor={`answer-${q.id}`}>Cevabınız</label>
          <textarea id={`answer-${q.id}`} rows={3} maxLength={2000} placeholder="Kısa cevabınız…" value={drafts[q.id] ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))} />
          <div className="waiting-actions">
            <span className="waiting-actions-left">
              <Link to={chat(q.conversationId)} aria-label={`${q.customer.name} ile konuşmayı aç`}>Konuşmayı aç</Link>
              {isOwner && <label><input type="checkbox" checked={Boolean(teach[q.id])} onChange={(e) => setTeach((t) => ({ ...t, [q.id]: e.target.checked }))} /> Lina’ya öğret (bir daha sormasın)</label>}
            </span>
            <button className="btn btn-primary" disabled={sending === q.id || !(drafts[q.id] ?? "").trim()} onClick={() => void send(q)}>
              {sending === q.id ? "Gönderiliyor…" : "Cevabı gönder"}
            </button>
          </div>
        </article>)}
      </div>
      <button className="btn btn-secondary" onClick={() => setShowAnswered((v) => !v)}>{showAnswered ? "Cevaplananları gizle" : "Cevaplananları göster"}</button>
      {showAnswered && <div className="waiting-list">
        {answered?.length === 0 && <p className="hint">Henüz cevaplanan soru yok.</p>}
        {answered?.map((q) => <article key={q.id} className="panel-card waiting-card answered">
          <header><Who customer={q.customer} /> <span className="hint">· {q.answeredAt ? timeAgo(q.answeredAt) : ""}{q.answeredBy ? ` · ${q.answeredBy.name}` : ""}</span></header>
          <p className="waiting-question"><span className="waiting-label">Lina sordu:</span> {q.question}</p>
          <p><span className="waiting-label">Cevap:</span> {q.answer}</p>
          <div className="waiting-actions"><Link to={chat(q.conversationId)} aria-label={`${q.customer.name} ile konuşmayı aç`}>Konuşmayı aç</Link></div>
        </article>)}
      </div>}
    </section>

    <section aria-labelledby="forwarded">
      <h2 id="forwarded">Ekibe iletilenler{forwarded?.length ? ` (${forwarded.length})` : ""}</h2>
      <p className="hint">Lina’nın size bıraktığı talepler: şikayet, iade kararı, iptal, değişiklik, gecikme. En uzun bekleyen üstte. Lina müşteriye talebin iletildiğini söylemiş olabilir. İşlemi yapınca “Tamamlandı” deyin.</p>
      {forwarded === null && !loadError && <p className="hint" role="status">Yükleniyor…</p>}
      {forwarded?.length === 0 && <p className="hint">Şu an ekibe iletilen talep yok.</p>}
      <div className="waiting-list">
        {forwarded?.map((n) => <article key={n.id} className="panel-card waiting-card" aria-label={`${n.customer.name} için talep`}>
          <header><Who customer={n.customer} /> <span className="hint">· {timeAgo(n.createdAt)}{n.updatedAt && ` · müşteri ${timeAgo(n.updatedAt)} yeniden yazdı`}</span></header>
          <p className="waiting-question">{n.label}{n.orderNames.length > 0 && ` (${n.orderNames.join(", ")})`}</p>
          {n.issues.length > 0 && <ul>{n.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
          {n.question && <p className="waiting-text"><span className="waiting-label">Müşteri:</span> {n.question}</p>}
          {n.answer && <p className="waiting-text"><span className="waiting-label">Lina:</span> {n.answer}</p>}
          <div className="waiting-actions">
            <Link to={chat(n.conversationId)} aria-label={`${n.customer.name} ile konuşmayı aç`}>Konuşmayı aç</Link>
            <button className="btn btn-primary" aria-label={`Tamamlandı: ${n.customer.name}, ${n.label}`} onClick={() => void complete(n)}>Tamamlandı</button>
          </div>
        </article>)}
      </div>
      <button className="btn btn-secondary" onClick={() => setShowDone((v) => !v)}>{showDone ? "Tamamlananları gizle" : "Tamamlananları göster"}</button>
      {showDone && <div className="waiting-list">
        {done?.length === 0 && <p className="hint">Henüz tamamlanan talep yok.</p>}
        {done?.map((n) => <article key={n.id} className="panel-card waiting-card answered">
          <header><Who customer={n.customer} /> <span className="hint">· {n.doneAt ? `${timeAgo(n.doneAt)} tamamlandı` : ""}{n.doneBy ? ` · ${n.doneBy.name}` : ""}</span></header>
          <p className="waiting-question">{n.label}{n.orderNames.length > 0 && ` (${n.orderNames.join(", ")})`}</p>
          {n.question && <p className="waiting-text"><span className="waiting-label">Müşteri:</span> {n.question}</p>}
          <div className="waiting-actions">
            <Link to={chat(n.conversationId)} aria-label={`${n.customer.name} ile konuşmayı aç`}>Konuşmayı aç</Link>
            <button className="btn btn-secondary" aria-label={`Geri al: ${n.customer.name}, ${n.label}`} onClick={() => void reopen(n)}>Geri al</button>
          </div>
        </article>)}
      </div>}
    </section>

    <section aria-labelledby="handed-off">
      <h2 id="handed-off">Devredilen konuşmalar{handedOff?.length ? ` (${handedOff.length})` : ""}</h2>
      <p className="hint">Müşteri temsilciyle görüşmek istedi ya da Lina konuyu çözemedi. Kimsenin devralmadığı en uzun bekleyen üstte; devralınmış olanlar altta.</p>
      {handedOff === null && !loadError && <p className="hint" role="status">Yükleniyor…</p>}
      {handedOff?.length === 0 && <p className="hint">Şu an devredilen konuşma yok.</p>}
      <div className="waiting-list">
        {handedOff?.map((c) => <article key={c.id} className="panel-card waiting-card" aria-label={`${c.customer.name} ile konuşma`}>
          <header><Who customer={c.customer} /> <span className="hint">{c.openHandoff ? `· ${timeAgo(c.openHandoff.createdAt)} ` : ""}· {statusLabel(c)}</span></header>
          {c.openHandoff && <p className="waiting-question">{HANDOFF_REASONS[c.openHandoff.reason] ?? c.openHandoff.reason}</p>}
          {c.openHandoff && <p className="waiting-text">{c.openHandoff.summary}</p>}
          <div className="waiting-actions"><span /><Link className="btn btn-secondary" to={chat(c.id)} aria-label={`${c.customer.name} ile konuşmayı aç`}>Konuşmayı aç</Link></div>
        </article>)}
      </div>
    </section>
  </main>;
}
