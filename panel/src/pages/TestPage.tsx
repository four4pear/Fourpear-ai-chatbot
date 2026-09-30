import { useEffect, useRef, useState } from "react";
import { api, type Membership } from "../api";

type Message = { role: "user" | "assistant"; text: string };
type Result = { replies: string[]; outcome: string; runs: { agent: string; question: string | null; answer: string | null; error: string | null }[]; handoffs: { summary: string }[]; demoHelp: string[] };

const AGENT_LABELS: Record<string, string> = { order: "Sipariş uzmanı", returns: "İade uzmanı", knowledge: "Mağaza bilgi uzmanı" };

/** WhatsApp'taki gibi: Lina son mesajdan bu kadar sonra cevaplar; her yeni mesajda bekleme baştan başlar. */
export const TEST_REPLY_DELAY_MS = 10_000;

export function TestPage({ store, replyDelayMs = TEST_REPLY_DELAY_MS }: { store: Membership; replyDelayMs?: number }) {
  const [history, setHistory] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // Zamanlayıcı ve istek, ekranın o anki sohbetini okur (eski çizimin kopyasını değil).
  const current = useRef<Message[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "nearest" }); }, [history, busy, waitUntil]);
  useEffect(() => {
    if (waitUntil === null) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [waitUntil]);
  // Sayfadan çıkınca bekleyen ya da hazırlanan cevap bırakılır.
  useEffect(() => () => { clearTimeout(timer.current); request.current?.abort(); }, []);

  function show(next: Message[]) { current.current = next; setHistory(next); }
  function cancelReply() {
    clearTimeout(timer.current); setWaitUntil(null);
    request.current?.abort(); request.current = null; setBusy(false);
  }
  function send() {
    if (!text.trim()) return;
    // Hazırlanan cevap iptal edilir; yeni mesajla birlikte hepsine tek cevap verilir.
    cancelReply();
    show([...current.current, { role: "user", text: text.trim() }]);
    setText(""); setError("");
    setNow(Date.now()); setWaitUntil(Date.now() + replyDelayMs);
    timer.current = setTimeout(() => void ask(), replyDelayMs);
  }
  async function ask() {
    setWaitUntil(null);
    const asked = current.current;
    const controller = new AbortController();
    request.current = controller; setBusy(true);
    try {
      const data = await api<Result>(`/tenants/${store.tenantId}/test`, { method: "POST", body: { history: asked, demo }, signal: controller.signal });
      if (controller.signal.aborted) return;
      setResult(data);
      if (data.replies.length) show([...asked, { role: "assistant", text: data.replies.join("\n\n") }]);
      else restore(asked, "Lina cevap vermedi. Mağazanın bot ayarlarını kontrol edin veya yeni sohbet açın.");
    } catch (e) {
      if (!controller.signal.aborted) restore(asked, e instanceof Error ? e.message : "Mesaj gönderilemedi");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }
  /** Cevaplanamayan mesajlar taslağa geri döner; tekrar gönderilebilir. */
  function restore(asked: Message[], message: string) {
    const answered = asked.map(m => m.role).lastIndexOf("assistant") + 1;
    show(asked.slice(0, answered));
    const unanswered = asked.slice(answered).map(m => m.text).join("\n");
    setText(draft => [unanswered, draft].filter(Boolean).join("\n"));
    setError(message);
  }
  function reset() { cancelReply(); show([]); setResult(null); setError(""); setText(""); }

  const seconds = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - now) / 1000));
  return <main className="page test-page">
    <div className="test-heading"><div><p className="hint">{store.name} · Deneme alanı</p><h1>Lina’yı test et</h1></div>
      <button className="btn btn-secondary" onClick={reset}>Yeni sohbet</button></div>
    <p className="hint">Müşteri gibi yazın, Lina’nın cevabını deneyin. Gerçek mağaza bilgileri ve yapay zekâ kullanılır; WhatsApp’a mesaj gönderilmez.</p>
    <div className="test-layout"><section className="panel-card test-chat" aria-label="Test sohbeti">
      <div className="test-messages" role="log" aria-live="polite">
        {!history.length && <div className="test-empty"><h2>İlk mesajı siz yazın.</h2><p>Kargo, iade veya ürünler hakkında bir soru sorun.</p>
          {["Merhaba, kargo kaç günde gelir?", "İade koşullarınız nelerdir?"].map(q => <button key={q} className="btn btn-secondary" onClick={() => setText(q)}>{q}</button>)}</div>}
        {history.map((m, i) => <div key={i} className={`test-message ${m.role}`}><span>{m.role === "user" ? "Siz" : "Lina"}</span><p>{m.text}</p></div>)}
        {waitUntil !== null && <p className="hint" role="status">Lina bekliyor… {seconds} sn. Yazmaya devam ederseniz bekleme baştan başlar.</p>}
        {busy && <p className="hint" role="status">Lina cevap hazırlıyor… Şimdi yazarsanız bu cevap iptal edilir, hepsine birlikte cevap verilir.</p>}
        <div ref={bottom} />
      </div>
      {error && <p role="alert" className="test-error">{error}</p>}
      <form className="test-compose" onSubmit={e => { e.preventDefault(); send(); }}><label className="sr-only" htmlFor="test-message">Mesajınız</label>
        <textarea id="test-message" value={text} maxLength={4000} rows={3} placeholder="Müşteri gibi bir mesaj yazın…" onChange={e => setText(e.target.value)} onKeyDown={e => { if(e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button className="btn btn-primary" disabled={!text.trim()}>Gönder</button></form>
    </section><aside className="panel-card test-details"><h2>Test ayarları</h2>
      <label><input type="checkbox" checked={demo} disabled={busy || history.length > 0} onChange={e => setDemo(e.target.checked)} /> Deneme siparişlerini kullan</label>
      <p className="hint">Siparişler örnektir. Bu seçimi değiştirmek için yeni sohbet açın.</p>
      <p className="hint">WhatsApp’taki gibi: Lina son mesajınızdan {replyDelayMs / 1000} sn sonra cevaplar. Bu sürede yazarsanız bekleme baştan başlar; art arda mesajlarınızı tek mesaj gibi okuyup tek cevap verir.</p>
      <p className="hint">Bu ekran metin sohbetini test eder. Konuşma geçmişi bu sayfada tutulur; müşteri kayıtlarına yazılmaz. Gerçek API kullanımı ücretlidir.</p>
      {result?.demoHelp.map(line => <p className="hint" key={line}>{line}</p>)}
      {result?.handoffs.map((h,i) => <p key={i}>Ekibe devir: {h.summary}</p>)}
      <h2>Son cevabın uzman çağrıları</h2>
      {result?.runs.filter(r => r.agent !== "lina").map((r,i) => <details key={i}><summary>{AGENT_LABELS[r.agent] ?? r.agent}</summary><p>{r.question}</p><p>{r.answer || r.error}</p></details>)}
      {!result && <p className="hint">İlk cevaptan sonra burada görünecek.</p>}
      {result?.runs.some(r => r.error) && <p role="alert" className="test-error">Yapay zekâ çağrısında hata oluştu. Sunucu kayıtlarını kontrol edin.</p>}
    </aside></div>
  </main>;
}
