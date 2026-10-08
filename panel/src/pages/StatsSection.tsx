import { useEffect, useState } from "react";
import { api, type Membership } from "../api";

type Stats = {
  days: number;
  conversations: number;
  solvedByLina: number;
  team: number;
  avgResponseMinutes: number | null;
  afterHours: number;
  reasons: { label: string; count: number }[];
  bucketSize: "hour" | "day";
  buckets: { key: string; solved: number; team: number }[];
};

const num = (n: number) => n.toLocaleString("tr-TR");

/** "20 dk", "1 sa 5 dk", "2 gün"; ekip henüz yazmadıysa çizgi. */
export function durationLabel(minutes: number | null) {
  if (minutes === null) return "—";
  if (minutes < 1) return "1 dk’dan az";
  const m = Math.round(minutes);
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} sa ${m % 60} dk` : `${h} sa`;
  return `${Math.floor(h / 24)} gün`;
}

const bucketLabel = (key: string, size: "hour" | "day") =>
  size === "hour" ? `${key.slice(11)}:00` : new Date(`${key}T12:00:00Z`).toLocaleDateString("tr-TR", { day: "numeric", month: "short", timeZone: "UTC" });

function Chart({ stats }: { stats: Stats }) {
  const { buckets, bucketSize } = stats;
  const max = Math.max(1, ...buckets.map((b) => b.solved + b.team));
  // Çok kova varsa etiketlerin hepsi sığmaz: her birkaçında birini yaz.
  const every = Math.ceil(buckets.length / 8);
  return <div className="chart" role="img" aria-label={`${bucketSize === "hour" ? "Saatlik" : "Günlük"} konuşmalar: ${stats.solvedByLina} Lina çözdü, ${stats.team} ekibe gitti`}>
    <div className="chart-bars">
      {buckets.map((b, i) => <div key={b.key} className="chart-col" title={`${bucketLabel(b.key, bucketSize)}: ${b.solved} Lina çözdü, ${b.team} ekibe gitti`}>
        <div className="chart-stack">
          {b.team > 0 && <span className="chart-team" style={{ height: `${(b.team / max) * 100}%` }} />}
          {b.solved > 0 && <span className="chart-solved" style={{ height: `${(b.solved / max) * 100}%` }} />}
        </div>
        <span className="chart-label">{i % every === 0 ? bucketLabel(b.key, bucketSize) : ""}</span>
      </div>)}
    </div>
  </div>;
}

/** İstatistik'in üst bölümü: konuşma sayıları, günlük dağılım, ekibe giden işlerin sebepleri. */
export function StatsSection({ store, days }: { store: Membership; days: number }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setStats(null); setError("");
    let current = true;
    api<Stats>(`/tenants/${store.tenantId}/stats?days=${days}`).then(
      (s) => { if (current) setStats(s); },
      (e) => { if (current) setError(e instanceof Error ? e.message : "Yüklenemedi"); },
    );
    return () => { current = false; };
  }, [store.tenantId, days]);

  if (error) return <p role="alert" className="test-error">{error}</p>;
  if (!stats) return <p className="hint" role="status">Yükleniyor…</p>;
  const share = stats.conversations ? Math.round((stats.solvedByLina / stats.conversations) * 100) : null;
  return <>
    <div className="stat-cards">
      <div className="panel-card"><span className="hint">Konuşma</span><strong>{num(stats.conversations)}</strong></div>
      <div className="panel-card"><span className="hint">Lina’nın tek başına çözdüğü</span><strong className="stat-good">{num(stats.solvedByLina)}</strong>{share !== null && <span className="hint">%{share}</span>}</div>
      <div className="panel-card"><span className="hint">Ekibe giden</span><strong>{num(stats.team)}</strong></div>
      <div className="panel-card"><span className="hint">Ekibin ortalama dönüş süresi</span><strong>{durationLabel(stats.avgResponseMinutes)}</strong></div>
      <div className="panel-card"><span className="hint">Mesai dışı gelen</span><strong>{num(stats.afterHours)}</strong></div>
    </div>
    <div className="stat-grid">
      <section className="panel-card stat-chart-card" aria-labelledby="stat-chart">
        <div className="stat-card-head">
          <h2 id="stat-chart">{stats.bucketSize === "hour" ? "Saatlik konuşmalar" : "Günlük konuşmalar"}</h2>
          <div className="chart-legend"><span><i className="chart-solved" />Lina çözdü</span><span><i className="chart-team" />Ekibe gitti</span></div>
        </div>
        {stats.conversations === 0 ? <p className="hint">Bu dönemde müşteri yazmadı.</p> : <Chart stats={stats} />}
      </section>
      <section className="panel-card stat-reasons" aria-labelledby="stat-reasons">
        <h2 id="stat-reasons">Ekibe giden işlerin sebepleri</h2>
        {stats.reasons.length === 0 ? <p className="hint">Bu dönemde ekibe giden iş yok.</p> : <ul>
          {stats.reasons.map((r) => <li key={r.label}><span>{r.label}</span><span className="stat-count">{num(r.count)}</span></li>)}
        </ul>}
        <p className="hint">Bir konuşma birden çok sebeple ekibe gitmiş olabilir; sayılar iş sayısıdır.</p>
      </section>
    </div>
  </>;
}
