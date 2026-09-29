import { useEffect, useRef, useState } from "react";
import { api, type Membership } from "../api";

type Message = { role: "user" | "assistant"; text: string };
type Result = { replies: string[]; outcome: string; runs: { agent: string; question: string | null; answer: string | null; error: string | null }[]; handoffs: { summary: string }[]; demoHelp: string[] };

export function TestPage({ store }: { store: Membership }) {
  const [history, setHistory] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "nearest" }); }, [history, busy]);
  async function send() {
    if (busy || !text.trim()) return;
    const next: Message[] = [...history, { role: "user", text: text.trim() }];
    setBusy(true); setError(""); setHistory(next); setText("");
    try {
      const data = await api<Result>(`/tenants/${store.tenantId}/test`, { method: "POST", body: { history: next, demo } });
      setResult(data);
      if (data.replies.length) setHistory([...next, { role: "assistant", text: data.replies.join("\n\n") }]);
      else { setHistory(history); setText(next.at(-1)!.text); setError("Lina cevap vermedi. Mağazanın bot ayarlarını kontrol edin veya yeni sohbet açın."); }
    } catch (e) { setError(e instanceof Error ? e.message : "Mesaj gönderilemedi"); setHistory(history); setText(next.at(-1)!.text); }
    finally { setBusy(false); }
  }
  return <main className="page test-page">
    <div className="test-heading"><div><p className="hint">{store.name} · Deneme alanı</p><h1>Lina’yı test et</h1></div>
      <button className="btn btn-secondary" disabled={busy} onClick={() => { setHistory([]); setResult(null); setError(""); setText(""); }}>Yeni sohbet</button></div>
    <p className="hint">Müşteri gibi yazın, Lina’nın cevabını deneyin. Gerçek mağaza bilgileri ve yapay zekâ kullanılır; WhatsApp’a mesaj gönderilmez.</p>
    <div className="test-layout"><section className="panel-card test-chat" aria-label="Test sohbeti">
      <div className="test-messages" role="log" aria-live="polite">
        {!history.length && <div className="test-empty"><h2>İlk mesajı siz yazın.</h2><p>Kargo, iade veya ürünler hakkında bir soru sorun.</p>
          {["Merhaba, kargo kaç günde gelir?", "İade koşullarınız nelerdir?"].map(q => <button key={q} className="btn btn-secondary" onClick={() => setText(q)}>{q}</button>)}</div>}
        {history.map((m, i) => <div key={i} className={`test-message ${m.role}`}><span>{m.role === "user" ? "Siz" : "Lina"}</span><p>{m.text}</p></div>)}
        {busy && <p className="hint" role="status">Lina cevap hazırlıyor…</p>}<div ref={bottom} />
      </div>
      {error && <p role="alert" className="test-error">{error}</p>}
      <form className="test-compose" onSubmit={e => { e.preventDefault(); void send(); }}><label className="sr-only" htmlFor="test-message">Mesajınız</label>
        <textarea id="test-message" value={text} maxLength={4000} rows={3} placeholder="Müşteri gibi bir mesaj yazın…" disabled={busy} onChange={e => setText(e.target.value)} onKeyDown={e => { if(e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        <button className="btn btn-primary" disabled={busy || !text.trim()}>{busy ? "Bekleniyor…" : "Gönder"}</button></form>
    </section><aside className="panel-card test-details"><h2>Test ayarları</h2>
      <label><input type="checkbox" checked={demo} disabled={busy || history.length > 0} onChange={e => setDemo(e.target.checked)} /> Deneme siparişlerini kullan</label>
      <p className="hint">Siparişler örnektir. Bu seçimi değiştirmek için yeni sohbet açın. Cevaplar bekleme süresi olmadan hazırlanır.</p>
      <p className="hint">Bu ekran metin sohbetini test eder. Konuşma geçmişi bu sayfada tutulur; müşteri kayıtlarına yazılmaz. Gerçek API kullanımı ücretlidir.</p>
      {result?.demoHelp.map(line => <p className="hint" key={line}>{line}</p>)}
      {result?.handoffs.map((h,i) => <p key={i}>Ekibe devir: {h.summary}</p>)}
      <h2>Son cevabın uzman çağrıları</h2>
      {result?.runs.filter(r => r.agent !== "lina").map((r,i) => <details key={i}><summary>{r.agent === "order" ? "Sipariş uzmanı" : "Mağaza bilgi uzmanı"}</summary><p>{r.question}</p><p>{r.answer || r.error}</p></details>)}
      {!result && <p className="hint">İlk cevaptan sonra burada görünecek.</p>}
      {result?.runs.some(r => r.error) && <p role="alert" className="test-error">Yapay zekâ çağrısında hata oluştu. Sunucu kayıtlarını kontrol edin.</p>}
    </aside></div>
  </main>;
}
