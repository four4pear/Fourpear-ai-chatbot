import { useEffect, useState } from "react";
import { api, type Membership } from "../api";

type Row = {
  agent: string;
  model: string;
  source: "live" | "test";
  runs: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  avgMs: number;
  costUsd: number | null;
};
type Totals = { source: "live" | "test"; costUsd: number; replies: number; perReplyUsd: number | null; cacheHitRate: number | null };
type Usage = { days: number; rows: Row[]; totals: Totals[] };

const AGENT_LABELS: Record<string, string> = {
  lina: "Lina",
  knowledge: "Mağaza bilgi uzmanı",
  order: "Sipariş uzmanı",
  returns: "İade uzmanı",
  memory: "Kart yazarı",
  trainer: "Eğitmen",
};
const PERIODS = [
  { days: 1, label: "Son 24 saat" },
  { days: 7, label: "Son 7 gün" },
  { days: 30, label: "Son 30 gün" },
];

export const usd = (n: number | null) => (n === null ? "—" : `$${n < 0.1 ? n.toFixed(4) : n.toFixed(2)}`);
const num = (n: number) => n.toLocaleString("tr-TR");
const pct = (n: number | null) => (n === null ? "—" : `%${Math.round(n * 100)}`);

/** İstatistik: yapay zekâ kullanımı ve tahmini maliyet; canlı konuşmalar ve test ekranı ayrı. */
export function UsagePage({ store }: { store: Membership }) {
  const [days, setDays] = useState(7);
  const [source, setSource] = useState<"live" | "test">("test");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setUsage(null);
    api<Usage>(`/tenants/${store.tenantId}/usage?days=${days}`).then(setUsage, (e) => setError(e instanceof Error ? e.message : "Yüklenemedi"));
  }, [store.tenantId, days]);

  const total = usage?.totals.find((t) => t.source === source);
  const rows = (usage?.rows ?? []).filter((r) => r.source === source).sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  return <main className="page usage-page">
    <div className="test-heading"><div><p className="hint">{store.name}</p><h1>İstatistik</h1></div></div>
    <p className="hint">Yapay zekâ kullanımı ve tahmini maliyet. Tutarlar Anthropic liste fiyatlarıyla hesaplanır; kesin tutar Anthropic faturasındadır.</p>
    <div className="usage-filters">
      <div role="group" aria-label="Dönem">{PERIODS.map((p) => <button key={p.days} className={`btn ${days === p.days ? "btn-primary" : "btn-secondary"}`} onClick={() => setDays(p.days)}>{p.label}</button>)}</div>
      <div role="group" aria-label="Kaynak">
        <button className={`btn ${source === "live" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSource("live")}>Müşteri konuşmaları</button>
        <button className={`btn ${source === "test" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSource("test")}>Test ekranı</button>
      </div>
    </div>
    {error && <p role="alert" className="test-error">{error}</p>}
    {!usage && !error && <p className="hint" role="status">Yükleniyor…</p>}
    {usage && <>
      <div className="usage-cards">
        <div className="panel-card"><span className="hint">Toplam tahmini tutar</span><strong>{usd(total?.costUsd ?? 0)}</strong></div>
        <div className="panel-card"><span className="hint">Lina'nın cevapları</span><strong>{num(total?.replies ?? 0)}</strong></div>
        <div className="panel-card"><span className="hint">Cevap başına</span><strong>{usd(total?.perReplyUsd ?? null)}</strong></div>
        <div className="panel-card"><span className="hint">Önbellekten okunan</span><strong>{pct(total?.cacheHitRate ?? null)}</strong></div>
      </div>
      {rows.length === 0 ? <p className="hint">Bu dönemde kayıt yok.</p> : <div className="usage-table-wrap"><table className="usage-table">
        <thead><tr><th>Ajan</th><th>Çalışma</th><th>API çağrısı</th><th>Girdi</th><th>Önbellekten okunan</th><th>Önbelleğe yazılan</th><th>Çıktı</th><th>Ort. süre</th><th>Tahmini tutar</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={`${r.agent}-${r.model}`}>
          <td>{AGENT_LABELS[r.agent] ?? r.agent}<br /><span className="hint">{r.model}</span></td>
          <td>{num(r.runs)}</td><td>{num(r.apiCalls)}</td><td>{num(r.inputTokens)}</td><td>{num(r.cacheReadTokens)}</td>
          <td>{num(r.cacheWriteTokens)}</td><td>{num(r.outputTokens)}</td><td>{(r.avgMs / 1000).toFixed(1)} sn</td><td>{usd(r.costUsd)}</td>
        </tr>)}</tbody>
      </table></div>}
    </>}
  </main>;
}
