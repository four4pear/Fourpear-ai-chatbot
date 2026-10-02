import { useEffect, useState } from "react";
import { api, type Membership } from "../api";

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
 * Bekleyenler: ekibin yapması gerekenler. İlk bölüm "Lina soruyor": Lina'nın bilmediği ve arka planda
 * ekibe sorduğu sorular. Ekip kısa bir cevap yazar; Lina müşteriye kendi cümleleriyle iletir.
 */
export function WaitingPage({ store }: { store: Membership }) {
  const [open, setOpen] = useState<Question[] | null>(null);
  const [answered, setAnswered] = useState<Question[] | null>(null);
  const [showAnswered, setShowAnswered] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [teach, setTeach] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const base = `/tenants/${store.tenantId}/team-questions`;
  const isOwner = store.role === "owner";

  async function load() {
    try {
      setOpen((await api<{ questions: Question[] }>(base)).questions);
      if (showAnswered) setAnswered((await api<{ questions: Question[] }>(`${base}?status=answered`)).questions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sorular yüklenemedi");
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [store.tenantId, showAnswered]);

  async function send(q: Question) {
    const answer = (drafts[q.id] ?? "").trim();
    if (!answer) return;
    setSending(q.id); setError(""); setNotice("");
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
      void load();
    } finally {
      setSending(null);
    }
  }

  return <main className="page waiting-page">
    <div className="test-heading"><div><p className="hint">{store.name}</p><h1>Bekleyenler</h1></div></div>
    {notice && <p className="waiting-notice" role="status">{notice}</p>}
    {error && <p role="alert" className="test-error">{error}</p>}

    <section aria-labelledby="lina-asks">
      <h2 id="lina-asks">Lina soruyor{open?.length ? ` (${open.length})` : ""}</h2>
      <p className="hint">Lina bilmediği konuları burada size soruyor. Kısa bir cevap yazın; Lina müşteriye kendi cümleleriyle iletir. Müşteri sizinle konuştuğunu bilmez.</p>
      {open === null && <p className="hint" role="status">Yükleniyor…</p>}
      {open?.length === 0 && <p className="hint">Şu an Lina’nın sorusu yok.</p>}
      <div className="waiting-list">
        {open?.map((q) => <article key={q.id} className="panel-card waiting-card" aria-label={`${q.customer.name} için soru`}>
          <header><strong>{q.customer.name}</strong> <span className="hint">{q.customer.phone} · {timeAgo(q.createdAt)}</span></header>
          {q.customerMessage && <p><span className="waiting-label">Müşteri:</span> {q.customerMessage}</p>}
          <p className="waiting-question"><span className="waiting-label">Lina soruyor:</span> {q.question}</p>
          {q.context && <p className="hint"><span className="waiting-label">Bağlam:</span> {q.context}</p>}
          <label className="sr-only" htmlFor={`answer-${q.id}`}>Cevabınız</label>
          <textarea id={`answer-${q.id}`} rows={3} maxLength={2000} placeholder="Kısa cevabınız…" value={drafts[q.id] ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))} />
          <div className="waiting-actions">
            {isOwner && <label><input type="checkbox" checked={Boolean(teach[q.id])} onChange={(e) => setTeach((t) => ({ ...t, [q.id]: e.target.checked }))} /> Lina’ya öğret (bir daha sormasın)</label>}
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
          <header><strong>{q.customer.name}</strong> <span className="hint">{q.answeredAt ? timeAgo(q.answeredAt) : ""}{q.answeredBy ? ` · ${q.answeredBy.name}` : ""}</span></header>
          <p className="waiting-question"><span className="waiting-label">Lina sordu:</span> {q.question}</p>
          <p><span className="waiting-label">Cevap:</span> {q.answer}</p>
        </article>)}
      </div>}
    </section>
  </main>;
}
