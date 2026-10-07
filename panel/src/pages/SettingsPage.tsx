import { useEffect, useState } from "react";
import { api, type Membership } from "../api";
import { useSession } from "../session";
import { Switch } from "../ui";
import { TeamSection } from "./TeamSection";

type Hours = { days: number[]; start: string; end: string };
type Settings = { botEnabled: boolean; botHoursOnly: boolean; businessHours: Hours };

/** Haftanın günleri, 0 = pazar (sunucudaki gibi); Türkiye'de hafta pazartesi başlar. */
const DAYS = [
  { n: 1, label: "Pzt" }, { n: 2, label: "Sal" }, { n: 3, label: "Çar" }, { n: 4, label: "Per" },
  { n: 5, label: "Cum" }, { n: 6, label: "Cmt" }, { n: 0, label: "Paz" },
];

/** Ayarlar (taslaktaki düzen): solda bölümler, sağda kartlar. Diğer ayarlar sırayla eklenecek. */
export function SettingsPage({ store }: { store: Membership }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hours, setHours] = useState<Hours | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const path = `/tenants/${store.tenantId}/settings`;
  const { me } = useSession();

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

  function toggleBot(next: boolean) {
    if (!settings || busy) return;
    if (!next && !window.confirm("Lina kapatılsın mı? Müşterilere hiç cevap verilmeyecek; mesajlar panelde görünür ve konuşmaları siz devralıp yazabilirsiniz.")) return;
    void save({ botEnabled: next }, next ? "Lina açıldı." : "Lina kapatıldı.");
  }

  const dirty = settings && hours && JSON.stringify(hours) !== JSON.stringify(settings.businessHours);
  return <main className="page settings-page">
    <div className="settings-head">
      <div><p className="hint">{store.name}</p><h1>Ayarlar</h1></div>
      {settings && <div className="settings-bot">
        <span>{settings.botEnabled ? "Lina açık: müşterilere cevap veriyor." : "Lina kapalı: hiçbir müşteriye cevap vermiyor."}</span>
        <Switch checked={settings.botEnabled} disabled={busy} label="Lina" onChange={toggleBot} />
      </div>}
    </div>
    {notice && <p className="waiting-notice" role="status">{notice}</p>}
    {error && <p role="alert" className="test-error">{error}</p>}
    {!settings && !error && <p className="hint" role="status">Yükleniyor…</p>}

    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Ayar bölümleri">
        <a href="#lina">Lina</a>
        <a href="#mesai">Mesai saatleri</a>
        {me && <a href="#team">Ekip</a>}
      </nav>
      <div className="settings-sections">
        {settings && hours && <>
          <section id="lina" className="panel-card settings-card" aria-labelledby="bot-switch">
            <h2 id="bot-switch">Lina</h2>
            <p>{settings.botEnabled
              ? "Bir sorun görürseniz Lina'yı sağ üstteki anahtarla hemen durdurabilirsiniz. Mesajlar panelde görünmeye devam eder; konuşmaları devralıp müşteriye siz yazabilirsiniz."
              : "Müşteri mesajları panelde görünür ama cevaplanmaz. Hazır olunca anahtarı tekrar açın; açıldığında yalnızca yeni mesajlara cevap verilir."}</p>
          </section>

          <section id="mesai" className="panel-card settings-card" aria-labelledby="hours">
            <div><h2 id="hours">Mesai saatleri</h2><p className="hint">Ekibin ne zaman çalıştığını belirtir; Lina, devrettiği müşteriye ne zaman dönüleceğini buna göre söyler.</p></div>
            <div className="days" role="group" aria-label="Çalışılan günler">
              {DAYS.map((d) => {
                const on = hours.days.includes(d.n);
                return <button key={d.n} type="button" className={`day${on ? " on" : ""}`} aria-pressed={on} aria-label={d.label}
                  onClick={() => setHours({ ...hours, days: on ? hours.days.filter((x) => x !== d.n) : [...hours.days, d.n] })}>
                  <strong>{d.label}</strong><span>{on ? `${hours.start}–${hours.end}` : "Kapalı"}</span>
                </button>;
              })}
            </div>
            <div className="field-row">
              <div className="field"><label htmlFor="hours-start">Başlangıç</label><input id="hours-start" type="time" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} /></div>
              <div className="field"><label htmlFor="hours-end">Bitiş</label><input id="hours-end" type="time" value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} /></div>
              <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save({ businessHours: hours }, "Mesai saatleri kaydedildi.")}>Mesai saatlerini kaydet</button>
            </div>
            <div className="switch-row">
              <div>
                <strong>Lina yalnızca mesai saatlerinde cevap versin</strong>
                <p className="hint">{settings.botHoursOnly
                  ? "Mesai dışında gelen mesajlar kaydedilir, müşteriye bir şey yazılmaz; mesai başlayınca Lina bekleyen mesajlara cevap verir."
                  : "Kapalıyken Lina her saat cevap verir; mesai saatleri yalnızca ekibin ne zaman çalıştığını belirtir."}</p>
              </div>
              <Switch checked={settings.botHoursOnly} disabled={busy} label="Lina yalnızca mesai saatlerinde cevap versin"
                onChange={(next) => void save({ botHoursOnly: next }, next ? "Lina artık yalnızca mesai saatlerinde cevap verecek." : "Lina yeniden her saat cevap verecek.")} />
            </div>
          </section>
        </>}
        {me && <TeamSection store={store} userId={me.user.id} />}
        <p className="hint">Lina'ya notlar ve sabit metinler sonraki adımlarda burada olacak.</p>
      </div>
    </div>
  </main>;
}
