import { useEffect, useMemo, useRef, useState } from "react";
import { api, waitingChanged, type Membership } from "../api";
import { Link } from "../router";
import { ChromeBar } from "../Shell";
import { ConversationPane } from "./ConversationPane";
import {
  ago, buildQueue, initials, LATE_MINUTES, preview, statusLabel, useLive, waitLabel, waitMinutes,
  type ConversationRow, type Forwarded, type Question, type Tone,
} from "./inbox-shared";

type Tab = "waiting" | "mine" | "all";
const TABS: { key: Tab; label: string }[] = [
  { key: "waiting", label: "Bekleyen" },
  { key: "mine", label: "Bende" },
  { key: "all", label: "Tümü" },
];

/** Sunucunun bir sayfada döndürdüğü konuşma sayısı. */
const PAGE_SIZE = 50;

/**
 * Gelen kutusu (onaylanan taslak): solda ekibin yapması gerekenler, ortada konuşma, sağda müşteri kartı.
 * Telefonda liste ve konuşma ayrı ekranlardır. /bekleyenler ve /sohbetler aynı ekrandır; yalnızca açılışta
 * hangi sekmenin seçili olduğu değişir.
 */
export function InboxPage({ store, userId, section, conversationId }: { store: Membership; userId: string; section: "bekleyenler" | "sohbetler"; conversationId?: string }) {
  const [tab, setTab] = useState<Tab>(section === "bekleyenler" ? "waiting" : "all");
  // Soldaki menüden başka bölüme geçilince sekme de onu izler.
  useEffect(() => setTab(section === "bekleyenler" ? "waiting" : "all"), [section]);

  return <div className={`inbox${conversationId ? " has-chat" : ""}`}>
    <QueuePane store={store} section={section} tab={tab} setTab={setTab} selectedId={conversationId} />
    <div className="inbox-chat">
      {conversationId
        ? <ConversationPane key={conversationId} store={store} conversationId={conversationId} userId={userId} backTo={`/m/${store.slug}/${section}`} />
        : <div className="inbox-empty"><p>Soldan bir konuşma seçin.</p><p className="hint">Müşteriyle yazışmayı, Lina’nın özetini ve müşteri kartını burada görürsünüz.</p></div>}
    </div>
  </div>;
}

const TONE_CLASS: Record<Tone, string> = { red: "chip-red", amber: "chip-amber", blue: "chip-blue", green: "chip-green", grey: "chip-grey" };

function QueuePane({ store, section, tab, setTab, selectedId }: { store: Membership; section: "bekleyenler" | "sohbetler"; tab: Tab; setTab: (t: Tab) => void; selectedId?: string }) {
  const tenant = `/tenants/${store.tenantId}`;
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [forwarded, setForwarded] = useState<Forwarded[] | null>(null);
  const [handedOff, setHandedOff] = useState<ConversationRow[] | null>(null);
  const [mine, setMine] = useState<ConversationRow[] | null>(null);
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Eski sayfalar yüklendiyse yenilenen ilk sayfa listenin yerine geçmez, içine karışır. */
  const olderLoaded = useRef(false);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [done, setDone] = useState<Forwarded[] | null>(null);
  const [answered, setAnswered] = useState<Question[] | null>(null);
  const [error, setError] = useState("");
  /** İlk yükleme bitti (başarılı ya da değil): yüklenemeyen kaynak boş sayılır, diğerleri görünür. */
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const allBase = `${tenant}/conversations?view=all${query ? `&q=${encodeURIComponent(query)}` : ""}`;

  // Yazarken her tuşta sunucuya gitmesin.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  // Bekleme süreleri (42 dk → 43 dk) sunucuya gitmeden her dakika tazelenir.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  /** Aynı konuşma iki sayfada da gelebilir: yenisi geçerlidir; liste en son hareket edene göre sıralanır. */
  const merge = (current: ConversationRow[] | null, incoming: ConversationRow[]) => {
    const byId = new Map((current ?? []).map((c) => [c.id, c]));
    for (const c of incoming) byId.set(c.id, c);
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  useEffect(() => { setRows(null); setMore(false); olderLoaded.current = false; }, [allBase]);

  /** Kaynaklar birbirinden bağımsız yüklenir: biri başarısız olsa da diğerleri görünür. */
  async function load() {
    const results = await Promise.allSettled([
      api<{ questions: Question[] }>(`${tenant}/team-questions`).then((r) => setQuestions(r.questions)),
      api<{ notifications: Forwarded[] }>(`${tenant}/notifications?filter=important`).then((r) => setForwarded(r.notifications)),
      api<{ conversations: ConversationRow[] }>(`${tenant}/conversations?view=waiting`).then((r) => setHandedOff(r.conversations)),
      api<{ conversations: ConversationRow[] }>(`${tenant}/conversations?view=mine`).then((r) => setMine(r.conversations)),
      tab === "all"
        ? api<{ conversations: ConversationRow[] }>(allBase).then((r) => {
            if (olderLoaded.current) setRows((current) => merge(current, r.conversations));
            else { setRows(r.conversations); setMore(r.conversations.length === PAGE_SIZE); }
          })
        : null,
      showDone ? api<{ notifications: Forwarded[] }>(`${tenant}/notifications?filter=important&status=done`).then((r) => setDone(r.notifications)) : null,
      showDone ? api<{ questions: Question[] }>(`${tenant}/team-questions?status=answered`).then((r) => setAnswered(r.questions)) : null,
    ]);
    waitingChanged();
    setReady(true);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    setError(failed ? (failed.reason instanceof Error ? failed.reason.message : "Liste yüklenemedi") : "");
  }
  useLive(load, [store.tenantId, tab, allBase, showDone]);

  async function loadOlder() {
    const last = rows?.at(-1);
    if (!last || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const list = (await api<{ conversations: ConversationRow[] }>(`${allBase}&before=${encodeURIComponent(last.updatedAt)}`)).conversations;
      olderLoaded.current = true;
      setRows((current) => merge(current, list));
      setMore(list.length === PAGE_SIZE);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Sohbetler yüklenemedi"); }
    finally { setLoadingOlder(false); }
  }

  const queue = useMemo(
    () => (ready ? buildQueue({ questions: questions ?? [], forwarded: forwarded ?? [], handedOff: handedOff ?? [] }) : null),
    [ready, questions, forwarded, handedOff],
  );
  const open = (id: string) => `/m/${store.slug}/${section}/${id}`;
  const title = section === "bekleyenler" ? "Bekleyenler" : "Tüm sohbetler";

  async function reopen(n: Forwarded) {
    try { await api(`${tenant}/notifications/${n.id}/reopen`, { method: "POST" }); } catch (e) { setError(e instanceof Error ? e.message : "Geri alınamadı"); }
    void load();
  }

  const loading = <p className="hint q-note" role="status">Yükleniyor…</p>;
  return <section className="q" aria-label="Konuşmalar">
    <header className="q-head">
      <div className="chrome"><ChromeBar /></div>
      <div className="q-title"><h1>{title}</h1>{tab === "waiting" && <span className="hint">en uzun bekleyen üstte</span>}</div>
      <div className="seg" role="tablist" aria-label="Görünüm">
        {TABS.map((t) => {
          const count = t.key === "waiting" ? queue?.length : t.key === "mine" ? mine?.length : undefined;
          return <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}{count ? <span className="seg-count"> {count}</span> : null}
          </button>;
        })}
      </div>
      {tab === "all" && <>
        <label className="sr-only" htmlFor="conversation-search">Müşteri ara</label>
        <input id="conversation-search" className="q-search" type="search" placeholder="Ad ya da telefonla ara…" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </>}
    </header>

    {error && <p role="alert" className="q-error">{error}</p>}

    <div className="q-body">
      {tab === "waiting" && <>
        {queue === null && !error && loading}
        {queue?.length === 0 && <p className="hint q-note">Şu an ekibi bekleyen iş yok. Lina müşterilere cevap veriyor.</p>}
        <ul className="q-list">
          {queue?.map((item) => {
            const late = waitMinutes(item.since, now) >= LATE_MINUTES;
            return <li key={item.id}>
              <Link className="q-item" to={open(item.id)} aria-current={item.id === selectedId ? "true" : undefined}
                aria-label={`${item.customer.name}${item.customer.name !== item.customer.phone ? `, ${item.customer.phone}` : ""}, ${item.chips.map((c) => c.label).join(", ")}, ${waitLabel(item.since, now)} bekliyor`}>
                <span className="q-row">
                  <span className="avatar-sm" aria-hidden="true">{initials(item.customer.name)}</span>
                  <span className="q-name">{item.customer.name}</span>
                  <span className={`q-wait${late ? " late" : ""}`}>{waitLabel(item.since, now)}</span>
                </span>
                <span className="q-chips">{item.chips.map((c) => <span key={c.label} className={`chip ${TONE_CLASS[c.tone]}`}>{c.label}</span>)}</span>
                {item.summary && <span className="q-summary">{item.summary}</span>}
              </Link>
            </li>;
          })}
        </ul>
        <button type="button" className="q-toggle" onClick={() => setShowDone((v) => !v)}>{showDone ? "Tamamlananları gizle" : "Tamamlananları göster"}</button>
        {showDone && <div className="q-done">
          {done?.length === 0 && answered?.length === 0 && <p className="hint q-note">Henüz tamamlanan iş yok.</p>}
          <ul className="q-list">
            {done?.map((n) => <li key={n.id} className="q-item done">
              <Link to={open(n.conversationId)} className="q-done-link" aria-label={`${n.customer.name} ile konuşmayı aç`}>
                <span className="q-name">{n.customer.name}</span>
                <span className="q-summary">{n.label}{n.orderNames.length > 0 && ` (${n.orderNames.join(", ")})`} · {n.doneAt ? `${ago(n.doneAt, now)} tamamlandı` : ""}{n.doneBy ? ` · ${n.doneBy.name}` : ""}</span>
              </Link>
              <button type="button" className="btn btn-secondary btn-sm" aria-label={`Geri al: ${n.customer.name}, ${n.label}`} onClick={() => void reopen(n)}>Geri al</button>
            </li>)}
            {answered?.map((q) => <li key={q.id} className="q-item done">
              <Link to={open(q.conversationId)} className="q-done-link" aria-label={`${q.customer.name} ile konuşmayı aç`}>
                <span className="q-name">{q.customer.name}</span>
                <span className="q-summary">Lina sordu: {q.question} · Cevap: {q.answer}{q.answeredBy ? ` · ${q.answeredBy.name}` : ""}</span>
              </Link>
            </li>)}
          </ul>
        </div>}
      </>}

      {tab === "mine" && <>
        {mine === null && !error && loading}
        {mine?.length === 0 && <p className="hint q-note">Devraldığınız konuşma yok.</p>}
        <ConversationList rows={mine} open={open} selectedId={selectedId} now={now} />
      </>}

      {tab === "all" && <>
        {rows === null && !error && loading}
        {rows?.length === 0 && <p className="hint q-note">{query ? "Bu aramayla eşleşen konuşma yok." : "Henüz WhatsApp konuşması yok. Müşteriler yazdıkça burada görünecek."}</p>}
        <ConversationList rows={rows} open={open} selectedId={selectedId} now={now} />
        {more && (rows?.length ?? 0) > 0 && <button type="button" className="q-toggle" disabled={loadingOlder} onClick={() => void loadOlder()}>Daha eski sohbetler</button>}
      </>}
    </div>
  </section>;
}

function ConversationList({ rows, open, selectedId, now }: { rows: ConversationRow[] | null; open: (id: string) => string; selectedId?: string; now: number }) {
  return <ul className="q-list">
    {rows?.map((c) => <li key={c.id}>
      <Link className="q-item" to={open(c.id)} aria-current={c.id === selectedId ? "true" : undefined}>
        <span className="q-row">
          <span className="avatar-sm" aria-hidden="true">{initials(c.customer.name)}</span>
          <span className="q-name">{c.customer.name}</span>
          <span className="q-wait">{waitLabel(c.lastMessage?.createdAt ?? c.updatedAt, now)}</span>
        </span>
        <span className="q-chips"><span className={`chip ${c.status === "waiting" ? "chip-red" : c.status === "human" ? "chip-green" : "chip-grey"}`}>{statusLabel(c)}</span></span>
        <span className="q-summary">{preview(c.lastMessage)}</span>
      </Link>
    </li>)}
  </ul>;
}
