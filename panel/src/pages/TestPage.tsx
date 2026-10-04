import { useEffect, useRef, useState } from "react";
import { api, type Membership } from "../api";
import { usd } from "./UsagePage";

/** team: ekibin "Lina soruyor" cevabı (testte ekip yerine siz cevaplarsınız). */
type Turn = { role: "user" | "assistant" | "team"; text: string; question?: string };
/** notifications ve summary: son cevabın karar özeti (ekibe ne gitti, cevap kaça mal oldu). */
type Result = { replies: string[]; outcome: string; runs: { agent: string; question: string | null; answer: string | null; error: string | null }[]; handoffs: { summary: string }[]; demoHelp: string[]; memory?: string | null; teamQuestions?: { question: string; context: string }[];
  notifications?: { label: string; important: boolean; orders: string[]; issues: string[] }[];
  summary?: { costUsd: number | null; memoryCostUsd: number | null; durationMs: number; apiCalls: number } };
type Proposal = { summary: string; lessons: string[]; replaces: { id: string; text: string }[] };
type Lesson = { id: string; text: string };
type Scenario = { order: string; label: string; sample: string };

/** Ekrandaki sohbet: müşteri ve Lina mesajları, geri bildirimler ve Lina'nın çıkardığı dersler. */
type Entry =
  | { kind: "user"; text: string }
  /** superseded: ders sonrası "tekrar sor" ile yerine yenisi gelen cevap (Lina'ya gönderilmez). */
  | { kind: "assistant"; text: string; superseded?: boolean }
  | { kind: "feedback"; text: string }
  | { kind: "proposal"; feedback: string; proposal: Proposal; drafts: string[]; state: "open" | "saving" | "saved" | "dismissed"; error?: string }
  /** Lina soruyor: Lina'nın arka planda ekibe sorduğu soru; testte ekip yerine siz cevaplarsınız. */
  | { kind: "asked"; question: string; context: string; draft: string; teach: boolean; state: "open" | "answered"; answer?: string };

const AGENT_LABELS: Record<string, string> = { order: "Sipariş uzmanı", returns: "İade uzmanı", knowledge: "Mağaza bilgi uzmanı" };

/** "geri bildirim: ..." ile başlayan mesaj müşteri mesajı değil, Lina için derstir. */
const FEEDBACK_PREFIX = /^\s*ger[iı]?\s*b[iı]ld[iı]r[iı]?m\b[\s:：\-–—]*/i;

/** WhatsApp'taki gibi: Lina son mesajdan bu kadar sonra cevaplar; her yeni mesajda bekleme baştan başlar. */
export const TEST_REPLY_DELAY_MS = 10_000;

/** Lina'ya giden konuşma: yalnızca müşteri ve (yerine yenisi gelmemiş) Lina mesajları. */
const conversationOf = (entries: Entry[]): Turn[] =>
  entries.flatMap((e): Turn[] => {
    if (e.kind === "user") return [{ role: "user", text: e.text }];
    if (e.kind === "assistant" && !e.superseded) return [{ role: "assistant", text: e.text }];
    if (e.kind === "asked" && e.answer) return [{ role: "team", question: e.question, text: e.answer }];
    return [];
  });

export function TestPage({ store, replyDelayMs = TEST_REPLY_DELAY_MS }: { store: Membership; replyDelayMs?: number }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [training, setTraining] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  // Düzenlenen ders (sağdaki listede).
  const [editing, setEditing] = useState<Lesson | null>(null);
  // Müşteri kartı: Lina'nın bu test müşterisi hakkında hatırladıkları (her cevaptan sonra güncellenir).
  const [memory, setMemoryState] = useState<string | null>(null);
  const memoryRef = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // Zamanlayıcı ve istek, ekranın o anki sohbetini okur (eski çizimin kopyasını değil).
  const current = useRef<Entry[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const request = useRef<AbortController | null>(null);
  const base = `/tenants/${store.tenantId}`;
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "nearest" }); }, [entries, busy, waitUntil, training]);
  useEffect(() => {
    if (waitUntil === null) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [waitUntil]);
  // Sayfadan çıkınca bekleyen ya da hazırlanan cevap bırakılır.
  useEffect(() => () => { clearTimeout(timer.current); request.current?.abort(); }, []);
  useEffect(() => { void loadLessons(); }, [store.tenantId]);
  useEffect(() => {
    if (!demo || scenarios.length) return;
    api<{ scenarios: Scenario[] }>(`${base}/test/demo-orders`).then((r) => setScenarios(r.scenarios), () => setScenarios([]));
  }, [demo]);

  async function loadLessons() {
    try { setLessons((await api<{ lessons: Lesson[] }>(`${base}/lessons`)).lessons); } catch { setLessons([]); }
  }
  function show(next: Entry[]) { current.current = next; setEntries(next); }
  function setMemory(next: string | null) { memoryRef.current = next; setMemoryState(next); }
  function update(index: number, entry: Entry) { show(current.current.map((e, i) => (i === index ? entry : e))); }
  function cancelReply() {
    clearTimeout(timer.current); setWaitUntil(null);
    request.current?.abort(); request.current = null; setBusy(false);
  }
  function scheduleReply(delayMs: number) {
    setNow(Date.now()); setWaitUntil(Date.now() + delayMs);
    timer.current = setTimeout(() => void ask(), delayMs);
  }
  function send() {
    const raw = text.trim();
    if (!raw) return;
    // Türkçe küçük harfe çevrilerek bakılır: "GERİ BİLDİRİM" de tanınsın (uzunluk değişmez).
    const feedback = FEEDBACK_PREFIX.exec(raw.toLocaleLowerCase("tr-TR"));
    if (feedback) {
      const body = raw.slice(feedback[0].length).trim();
      if (!body) { setError("Geri bildirimi “geri bildirim:” yazısından sonra yazın."); return; }
      setText(""); setError("");
      void giveFeedback(body);
      return;
    }
    // Hazırlanan cevap iptal edilir; yeni mesajla birlikte hepsine tek cevap verilir.
    cancelReply();
    show([...current.current, { kind: "user", text: raw }]);
    setText(""); setError("");
    scheduleReply(replyDelayMs);
  }
  async function ask() {
    setWaitUntil(null);
    const asked = conversationOf(current.current);
    // Lina müşteri mesajına ya da ekibin cevabına (Lina soruyor) cevap verir.
    if (asked.at(-1)?.role !== "user" && asked.at(-1)?.role !== "team") return;
    const controller = new AbortController();
    request.current = controller; setBusy(true);
    try {
      const data = await api<Result>(`${base}/test`, { method: "POST", body: { history: asked, demo, memory: memoryRef.current }, signal: controller.signal });
      if (controller.signal.aborted) return;
      setResult(data);
      if (data.memory !== undefined) setMemory(data.memory);
      if (data.replies.length) {
        const askedTeam = (data.teamQuestions ?? []).map((q): Entry => ({ kind: "asked", ...q, draft: "", teach: false, state: "open" }));
        show([...current.current, { kind: "assistant", text: data.replies.join("\n\n") }, ...askedTeam]);
      }
      else restore("Lina cevap vermedi. Yeni sohbet açıp tekrar deneyin.");
    } catch (e) {
      if (!controller.signal.aborted) restore(e instanceof Error ? e.message : "Mesaj gönderilemedi");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }
  /** Cevaplanamayan müşteri mesajları taslağa geri döner; tekrar gönderilebilir. */
  function restore(message: string) {
    const list = current.current;
    const lastReply = list.map((e) => e.kind === "assistant" && !e.superseded).lastIndexOf(true);
    const unanswered = list.filter((e, i) => i > lastReply && e.kind === "user").map((e) => (e as { text: string }).text);
    show(list.filter((e, i) => !(i > lastReply && e.kind === "user")));
    setText(draft => [unanswered.join("\n"), draft].filter(Boolean).join("\n"));
    setError(message);
  }
  async function giveFeedback(feedback: string) {
    show([...current.current, { kind: "feedback", text: feedback }]);
    setTraining(true);
    try {
      // Eğitmen yalnızca müşteri ve Lina mesajlarını okur; ekibin iç cevabı konuşmaya dahil değildir.
      const history = conversationOf(current.current).filter((t) => t.role !== "team");
      const proposal = await api<Proposal>(`${base}/test/feedback`, { method: "POST", body: { history, feedback } });
      show([...current.current, { kind: "proposal", feedback, proposal, drafts: proposal.lessons, state: proposal.lessons.length ? "open" : "dismissed" }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Geri bildirim değerlendirilemedi");
    } finally {
      setTraining(false);
    }
  }
  async function saveProposal(index: number) {
    const entry = current.current[index];
    if (entry?.kind !== "proposal") return;
    const texts = entry.drafts.map((d) => d.trim()).filter(Boolean);
    if (!texts.length) { update(index, { ...entry, error: "Kaydedilecek kural yok." }); return; }
    update(index, { ...entry, state: "saving", error: undefined });
    try {
      await api(`${base}/lessons`, { method: "POST", body: { texts, replaces: entry.proposal.replaces.map((r) => r.id), feedback: entry.feedback } });
      update(index, { ...entry, drafts: texts, state: "saved", error: undefined });
      await loadLessons();
    } catch (e) {
      update(index, { ...entry, state: "open", error: e instanceof Error ? e.message : "Kaydedilemedi" });
    }
  }
  /** Ders sonrası: Lina'nın son cevabı bir kenara bırakılır, aynı soruyu yeni kurallarla yeniden cevaplar. */
  function retryLast() {
    const list = current.current;
    const last = list.map((e) => e.kind === "assistant" && !e.superseded).lastIndexOf(true);
    if (last < 0) return;
    cancelReply();
    show(list.map((e, i) => (i === last && e.kind === "assistant" ? { ...e, superseded: true } : e)));
    void ask();
  }
  /** Testte ekip yerine cevap: cevap Lina'ya iç bilgi olarak gider, Lina müşteriye iletir. */
  async function answerAsked(index: number) {
    const entry = current.current[index];
    if (entry?.kind !== "asked" || !entry.draft.trim()) return;
    const answer = entry.draft.trim();
    update(index, { ...entry, state: "answered", answer });
    if (entry.teach) {
      try {
        await api(`${base}/lessons`, { method: "POST", body: { texts: [`${entry.question} → ${answer}`], source: "team" } });
        await loadLessons();
      } catch (e) { setError(e instanceof Error ? e.message : "Lina'ya öğretilemedi"); }
    }
    cancelReply();
    void ask();
  }
  async function saveLessonEdit() {
    if (!editing || !editing.text.trim()) return;
    try {
      await api(`${base}/lessons/${editing.id}`, { method: "PATCH", body: { text: editing.text.trim() } });
      setEditing(null);
      await loadLessons();
    } catch (e) { setError(e instanceof Error ? e.message : "Ders kaydedilemedi"); }
  }
  async function removeLesson(lesson: Lesson) {
    if (!window.confirm(`Bu ders silinsin mi?\n\n${lesson.text}`)) return;
    try { await api(`${base}/lessons/${lesson.id}`, { method: "DELETE" }); await loadLessons(); }
    catch (e) { setError(e instanceof Error ? e.message : "Ders silinemedi"); }
  }
  /** Yeni sohbet: yeni müşteri (kart da sıfırlanır). Aynı müşteri: kart kalır, müşteri günler sonra tekrar yazmış gibi. */
  function reset(keepCustomer = false) {
    cancelReply(); show([]); setResult(null); setError(""); setText("");
    if (!keepCustomer) setMemory(null);
  }

  const canRetry = !busy && entries.some((e) => e.kind === "assistant" && !e.superseded);
  const experts = result?.runs.filter((r) => r.agent !== "lina" && r.agent !== "memory") ?? [];
  const asked = result?.teamQuestions?.length ?? 0;
  const nothingToTeam = !result?.notifications?.length && !asked && !result?.handoffs.length;
  const seconds = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - now) / 1000));
  return <main className="page test-page">
    <div className="test-heading"><div><p className="hint">{store.name} · Deneme alanı</p><h1>Lina’yı test et</h1></div>
      <div className="test-heading-actions">
        <button className="btn btn-secondary" disabled={!memory} title="Müşteri kartı kalır; müşteri günler sonra tekrar yazmış gibi" onClick={() => reset(true)}>Aynı müşteri, yeni sohbet</button>
        <button className="btn btn-secondary" onClick={() => reset()}>Yeni sohbet</button>
      </div></div>
    <p className="hint">Müşteri gibi yazın, Lina’nın cevabını deneyin. Gerçek mağaza bilgileri ve yapay zekâ kullanılır; WhatsApp’a mesaj gönderilmez.</p>
    <div className="test-layout"><section className="panel-card test-chat" aria-label="Test sohbeti">
      <div className="test-messages" role="log" aria-live="polite">
        {!entries.length && <div className="test-empty"><h2>İlk mesajı siz yazın.</h2><p>Kargo, iade veya ürünler hakkında bir soru sorun.</p>
          {["Merhaba, kargo kaç günde gelir?", "İade koşullarınız nelerdir?"].map(q => <button key={q} className="btn btn-secondary" onClick={() => setText(q)}>{q}</button>)}</div>}
        {entries.map((e, i) => {
          if (e.kind === "user" || e.kind === "assistant") {
            const old = e.kind === "assistant" && e.superseded;
            return <div key={i} className={`test-message ${e.kind}${old ? " superseded" : ""}`}><span>{e.kind === "user" ? "Siz" : old ? "Lina (önceki cevap)" : "Lina"}</span><p>{e.text}</p></div>;
          }
          if (e.kind === "feedback") return <div key={i} className="test-message feedback"><span>Geri bildiriminiz</span><p>{e.text}</p></div>;
          if (e.kind === "asked") return <div key={i} className="test-lesson test-asked" aria-label="Lina ekibe sordu">
            <p><strong>Lina ekibe sordu</strong> <span className="hint">(müşteri görmez; canlıda Bekleyenler’e düşer)</span></p>
            <p>{e.question}</p>
            {e.context && <p className="hint">Bağlam: {e.context}</p>}
            {e.state === "open" ? <>
              <textarea aria-label="Ekibin cevabı" rows={2} maxLength={2000} placeholder="Ekip olarak kısa cevabınız…" value={e.draft}
                onChange={ev => update(i, { ...e, draft: ev.target.value })} />
              <div className="test-lesson-actions">
                <label><input type="checkbox" checked={e.teach} onChange={ev => update(i, { ...e, teach: ev.target.checked })} /> Lina’ya öğret</label>
                <button className="btn btn-primary" disabled={!e.draft.trim() || busy} onClick={() => void answerAsked(i)}>Ekip olarak cevapla</button>
              </div>
            </> : <p><strong>Ekibin cevabı:</strong> {e.answer}</p>}
          </div>;
          return <div key={i} className="test-lesson" aria-label="Lina'nın çıkardığı ders">
            <p><strong>{e.proposal.summary}</strong></p>
            {e.state === "dismissed" && !e.proposal.lessons.length && <p className="hint">Bu geri bildirimden kaydedilecek bir kural çıkmadı.</p>}
            {e.state === "dismissed" && e.proposal.lessons.length > 0 && <p className="hint">Kaydedilmedi.</p>}
            {(e.state === "open" || e.state === "saving") && <>
              <p className="hint">Lina bundan sonra şu kurallara uyacak; düzenleyebilirsiniz:</p>
              {e.drafts.map((d, j) => <textarea key={j} aria-label={`Kural ${j + 1}`} value={d} rows={3} maxLength={1000}
                onChange={ev => update(i, { ...e, drafts: e.drafts.map((x, k) => (k === j ? ev.target.value : x)) })} />)}
              {e.proposal.replaces.map(r => <p key={r.id} className="hint">Şu dersin yerine geçecek: {r.text}</p>)}
              {e.error && <p role="alert" className="test-error">{e.error}</p>}
              <div className="test-lesson-actions">
                <button className="btn btn-primary" disabled={e.state === "saving"} onClick={() => void saveProposal(i)}>{e.state === "saving" ? "Kaydediliyor…" : "Kaydet"}</button>
                <button className="btn btn-secondary" disabled={e.state === "saving"} onClick={() => update(i, { ...e, state: "dismissed" })}>Vazgeç</button>
              </div>
            </>}
            {e.state === "saved" && <>
              <p>Öğrenildi: WhatsApp’ta da hemen geçerli.</p>
              <ul>{e.drafts.map((d, j) => <li key={j}>{d}</li>)}</ul>
              <button className="btn btn-secondary" disabled={!canRetry} onClick={retryLast}>Son soruyu tekrar sor</button>
            </>}
          </div>;
        })}
        {waitUntil !== null && <p className="hint" role="status">Lina bekliyor… {seconds} sn. Yazmaya devam ederseniz bekleme baştan başlar.</p>}
        {busy && <p className="hint" role="status">Lina cevap hazırlıyor… Şimdi yazarsanız bu cevap iptal edilir, hepsine birlikte cevap verilir.</p>}
        {training && <p className="hint" role="status">Lina geri bildiriminizi değerlendiriyor…</p>}
        <div ref={bottom} />
      </div>
      {error && <p role="alert" className="test-error">{error}</p>}
      <form className="test-compose" onSubmit={e => { e.preventDefault(); send(); }}><label className="sr-only" htmlFor="test-message">Mesajınız</label>
        <textarea id="test-message" value={text} maxLength={4000} rows={3} placeholder="Müşteri gibi bir mesaj yazın… (Lina’yı düzeltmek için: geri bildirim: …)" onChange={e => setText(e.target.value)} onKeyDown={e => { if(e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button className="btn btn-primary" disabled={!text.trim()}>Gönder</button></form>
    </section><aside className="panel-card test-details"><h2>Test ayarları</h2>
      <label><input type="checkbox" checked={demo} disabled={busy || entries.length > 0} onChange={e => setDemo(e.target.checked)} /> Deneme siparişlerini kullan</label>
      <p className="hint">Siparişler örnektir. Bu seçimi değiştirmek için yeni sohbet açın.</p>
      {demo && scenarios.length > 0 && <div className="test-scenarios">
        <h2>Deneme siparişleri</h2>
        <p className="hint">Hepsi test müşterisine (Ayşe Yılmaz) ait; MO-9005 başka bir numaranın. Tıklayınca örnek mesaj yazılır, isterseniz değiştirip gönderin.</p>
        <ul>{scenarios.map((sc) => <li key={sc.order}>
          <button type="button" className="test-scenario" onClick={() => setText(sc.sample)}><strong>{sc.order}</strong> {sc.label}</button>
        </li>)}</ul>
      </div>}
      <p className="hint">WhatsApp’taki gibi: Lina son mesajınızdan {replyDelayMs / 1000} sn sonra cevaplar. Bu sürede yazarsanız bekleme baştan başlar; art arda mesajlarınızı tek mesaj gibi okuyup tek cevap verir.</p>
      <p className="hint">Bu ekran metin sohbetini test eder. Konuşma geçmişi bu sayfada tutulur; müşteri kayıtlarına yazılmaz. Gerçek API kullanımı ücretlidir.</p>
      <h2>Son cevabın karar özeti</h2>
      {!result && <p className="hint">İlk cevaptan sonra burada görünecek: Lina kime sordu, ekibe ne gitti, cevap kaça mal oldu.</p>}
      {result && <div className="test-decision">
        <h3>Kime soruldu</h3>
        {experts.length === 0 && <p>Lina kendi bilgisiyle cevapladı; uzmana sormadı.</p>}
        {experts.map((r,i) => <details key={i}><summary>{AGENT_LABELS[r.agent] ?? r.agent}</summary><p>{r.question}</p><p>{r.answer || r.error}</p></details>)}
        <h3>Ekibe ne gitti</h3>
        {nothingToTeam && <p>Ekibe bir şey gitmedi.</p>}
        {result.notifications?.map((n,i) => <div key={i}>
          <p><strong>{n.important ? "Önemli bildirim" : "Sessiz kayıt"}:</strong> {n.label}{n.orders.length > 0 && ` (${n.orders.join(", ")})`}</p>
          {n.issues.length > 0 && <ul>{n.issues.map((issue,j) => <li key={j}>{issue}</li>)}</ul>}
        </div>)}
        {asked > 0 && <p>Lina ekibe {asked} soru sordu; soru sohbette görünüyor.</p>}
        {result.handoffs.map((h,i) => <p key={i}>Ekibe devir: {h.summary}</p>)}
        {result.summary && <>
          <h3>Harcama</h3>
          {result.summary.apiCalls === 0
            ? <p>Bu cevapta yapay zekâ kullanılmadı.</p>
            : <p>Yaklaşık {usd(result.summary.costUsd)} · {Math.round(result.summary.durationMs / 1000)} sn · {result.summary.apiCalls} yapay zekâ çağrısı</p>}
          {result.summary.memoryCostUsd !== null && <p className="hint">Müşteri kartı güncellemesi ayrıca {usd(result.summary.memoryCostUsd)}. Canlıda her cevapta değil, müşteri susunca bir kez yapılır.</p>}
        </>}
        {result.runs.some(r => r.error) && <p role="alert" className="test-error">Yapay zekâ çağrısında hata oluştu. Sunucu kayıtlarını kontrol edin.</p>}
      </div>}
      <h2>Müşteri kartı</h2>
      <p className="hint">Lina’nın bu müşteri hakkında hatırladıkları. Müşteriye gösterilmez; Lina sessizce kullanır.</p>
      {memory ? <pre className="test-memory">{memory}</pre> : <p className="hint">Henüz boş; ilk cevaptan sonra dolar.</p>}
      <h2>Lina’nın öğrendikleri{lessons?.length ? ` (${lessons.length})` : ""}</h2>
      <p className="hint">Lina’nın cevabı yanlış ya da eksikse “geri bildirim: …” diye yazın. Lina bundan bir kural çıkarır; siz onaylayınca kaydedilir ve WhatsApp’ta da hemen geçerli olur.</p>
      {lessons?.length === 0 && <p className="hint">Henüz ders yok.</p>}
      {lessons && lessons.length > 0 && <ul className="test-lessons">{lessons.map(l => editing?.id === l.id
        ? <li key={l.id} className="editing">
            <textarea aria-label="Dersin metni" rows={5} maxLength={1000} value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })} />
            <div className="test-lesson-actions">
              <button className="btn btn-primary" disabled={!editing.text.trim()} onClick={() => void saveLessonEdit()}>Kaydet</button>
              <button className="btn btn-secondary" onClick={() => setEditing(null)}>Vazgeç</button>
            </div>
          </li>
        : <li key={l.id}><span>{l.text}</span>
            <span className="test-lesson-buttons">
              <button className="btn btn-secondary" aria-label={`Dersi düzenle: ${l.text}`} onClick={() => setEditing(l)}>Düzenle</button>
              <button className="btn btn-secondary" aria-label={`Dersi sil: ${l.text}`} onClick={() => void removeLesson(l)}>Sil</button>
            </span></li>)}</ul>}
    </aside></div>
  </main>;
}
