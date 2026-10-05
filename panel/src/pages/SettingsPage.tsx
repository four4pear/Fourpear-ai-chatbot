import { useEffect, useState } from "react";
import { api, type Membership } from "../api";

type Hours = { days: number[]; start: string; end: string };
type Settings = { botEnabled: boolean; botHoursOnly: boolean; businessHours: Hours };

/** Haftanın günleri, 0 = pazar (sunucudaki gibi); Türkiye'de hafta pazartesi başlar. */
const DAYS = [
  { n: 1, label: "Pzt" }, { n: 2, label: "Sal" }, { n: 3, label: "Çar" }, { n: 4, label: "Per" },
  { n: 5, label: "Cum" }, { n: 6, label: "Cmt" }, { n: 0, label: "Paz" },
];

/** Ayarlar: Lina'yı açıp kapatma (acil durdurma) ve mesai saatleri. Diğer ayarlar sırayla eklenecek. */
export function SettingsPage({ store }: { store: Membership }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hours, setHours] = useState<Hours | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const path = `/tenants/${store.tenantId}/settings`;

  useEffect(() => {
    api<Settings>(path).then((s) => { setSettings(s); setHours(s.businessHours); }, (e) => setError(e instanceof Error ? e.message : "Ayarlar yüklenemedi"));
  }, [path]);

  async function save(change: Partial<Settings>, done: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const s = await api<Settings>(path, { method: "PATCH", body: change });
      setSettings(s); setHours(s.businessHours); setNotice(done);
    } catch (e) { setError(e instanceof Error ? e.message : "Ayar kaydedilemedi"); }
    finally { setBusy(false); }
  }

  function toggleBot() {
    if (!settings || busy) return;
    const next = !settings.botEnabled;
    if (!next && !window.confirm("Lina kapatılsın mı? Müşterilere hiç cevap verilmeyecek; mesajlar panelde görünür ve konuşmaları siz devralıp yazabilirsiniz.")) return;
    void save({ botEnabled: next }, next ? "Lina açıldı." : "Lina kapatıldı.");
  }

  const dirty = settings && hours && JSON.stringify(hours) !== JSON.stringify(settings.businessHours);
  return <main className="page">
    <p className="hint">{store.name}</p>
    <h1>Ayarlar</h1>
    {notice && <p className="waiting-notice" role="status">{notice}</p>}
    {error && <p role="alert" className="test-error">{error}</p>}
    {!settings && !error && <p className="hint" role="status">Yükleniyor…</p>}
    {settings && hours && <>
      <section className="panel-card settings-card" aria-labelledby="bot-switch">
        <h2 id="bot-switch">Lina</h2>
        <p><strong>{settings.botEnabled ? "Lina açık: müşterilere cevap veriyor." : "Lina kapalı: hiçbir müşteriye cevap vermiyor."}</strong></p>
        <p className="hint">{settings.botEnabled
          ? "Bir sorun görürseniz Lina'yı buradan hemen durdurabilirsiniz. Mesajlar panelde görünmeye devam eder; konuşmaları devralıp müşteriye siz yazabilirsiniz."
          : "Müşteri mesajları panelde görünür ama cevaplanmaz. Hazır olunca tekrar açın; açıldığında yalnızca yeni mesajlara cevap verilir."}</p>
        <button className={`btn ${settings.botEnabled ? "btn-secondary" : "btn-primary"}`} disabled={busy} onClick={toggleBot}>
          {settings.botEnabled ? "Lina'yı kapat" : "Lina'yı aç"}
        </button>
      </section>

      <section className="panel-card settings-card" aria-labelledby="hours">
        <h2 id="hours">Mesai saatleri</h2>
        <fieldset className="settings-days"><legend className="sr-only">Çalışılan günler</legend>
          {DAYS.map((d) => <label key={d.n}><input type="checkbox" checked={hours.days.includes(d.n)}
            onChange={(e) => setHours({ ...hours, days: e.target.checked ? [...hours.days, d.n] : hours.days.filter((x) => x !== d.n) })} /> {d.label}</label>)}
        </fieldset>
        <div className="settings-times">
          <label>Başlangıç <input type="time" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} /></label>
          <label>Bitiş <input type="time" value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} /></label>
        </div>
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save({ businessHours: hours }, "Mesai saatleri kaydedildi.")}>Mesai saatlerini kaydet</button>
        <label className="settings-check">
          <input type="checkbox" checked={settings.botHoursOnly} disabled={busy}
            onChange={(e) => void save({ botHoursOnly: e.target.checked }, e.target.checked ? "Lina artık yalnızca mesai saatlerinde cevap verecek." : "Lina yeniden her saat cevap verecek.")} />
          Lina yalnızca mesai saatlerinde cevap versin
        </label>
        <p className="hint">{settings.botHoursOnly
          ? "Mesai dışında gelen mesajlar kaydedilir, müşteriye bir şey yazılmaz; mesai başlayınca Lina bekleyen mesajlara cevap verir."
          : "Kapalıyken Lina her saat cevap verir; mesai saatleri yalnızca ekibin ne zaman çalıştığını belirtir."}</p>
      </section>
    </>}
    <p className="hint">Lina'ya notlar, sabit metinler ve ekip yönetimi sonraki adımlarda burada olacak.</p>
  </main>;
}
