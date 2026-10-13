import { useEffect, useState } from "react";
import { api, type Membership } from "../api";
import { useSession } from "../session";
import { Switch } from "../ui";
import { TeamSection } from "./TeamSection";

type Hours = { days: number[]; start: string; end: string };
type Limits = { replyDelaySeconds: number; maxReplyWaitSeconds: number; dailyMessageLimit: number; dailyStoreMessageLimit: number };
type Texts = { unsupported: string; failure: string };
type Settings = {
  botEnabled: boolean; botHoursOnly: boolean; businessHours: Hours;
  notes: string; texts: Texts; defaultTexts: Texts; returnsPlaybook: string; limits: Limits;
  limitRanges: Record<keyof Limits, [number, number]>;
  deliveryDays: { min: number; max: number } | null; deliveryRange: [number, number];
};
type Delivery = { on: boolean; min: number; max: number };
type Alert = { id: string; topic: string; description: string; createdAt: string };
type Draft = { hours: Hours; notes: string; texts: Texts; playbook: string; limits: Limits; delivery: Delivery };

/** Sayısal ayarların adı, açıklaması ve birimi. */
const LIMIT_FIELDS: { key: keyof Limits; label: string; hint: string; unit: string }[] = [
  { key: "replyDelaySeconds", label: "Cevap bekleme süresi", unit: "saniye", hint: "Müşteri art arda yazarsa hepsine tek cevap verilsin diye son mesajdan sonra bu kadar beklenir. Önerilen: 30." },
  { key: "maxReplyWaitSeconds", label: "En fazla bekleme", unit: "saniye", hint: "Durmadan yazan müşteriye de en geç bu kadar sonra cevap verilir. Önerilen: 180." },
  { key: "dailyMessageLimit", label: "Bir müşteri günde en fazla", unit: "mesaj", hint: "Aşılırsa Lina o gün o müşteriye cevap vermez (spam ve otomatik cevap botlarına karşı); ekibe bildirim düşer. Önerilen: 200." },
  { key: "dailyStoreMessageLimit", label: "Mağaza günde en fazla", unit: "müşteri mesajı", hint: "Bütün müşterilerden gelen mesajlar bunu aşarsa Lina o gün kimseye cevap vermez; fatura koruması. Ekibe bildirim düşer. Önerilen: 3000." },
];

/** Haftanın günleri, 0 = pazar (sunucudaki gibi); Türkiye'de hafta pazartesi başlar. */
const DAYS = [
  { n: 1, label: "Pzt" }, { n: 2, label: "Sal" }, { n: 3, label: "Çar" }, { n: 4, label: "Per" },
  { n: 5, label: "Cum" }, { n: 6, label: "Cmt" }, { n: 0, label: "Paz" },
];

/** Ayarlar (taslaktaki düzen): solda bölümler, sağda kartlar. Diğer ayarlar sırayla eklenecek. */
export function SettingsPage({ store }: { store: Membership }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const path = `/tenants/${store.tenantId}/settings`;
  const { me } = useSession();

  const loadAlerts = () => api<{ alerts: Alert[] }>(`/tenants/${store.tenantId}/knowledge-alerts`).then((r) => setAlerts(r.alerts), () => {});
  useEffect(() => { void loadAlerts(); }, [store.tenantId]);
  async function resolveAlert(a: Alert) {
    setError(""); setNotice("");
    try { await api(`/tenants/${store.tenantId}/knowledge-alerts/${a.id}/resolve`, { method: "POST" }); setNotice(`"${a.topic}" çözüldü olarak işaretlendi.`); }
    catch (e) { setError(e instanceof Error ? e.message : "Uyarı kapatılamadı"); }
    await loadAlerts();
  }
  const deliveryOf = (s: Settings): Delivery => ({ on: s.deliveryDays !== null, min: s.deliveryDays?.min ?? 7, max: s.deliveryDays?.max ?? 14 });
  const draftOf = (s: Settings): Draft => ({ hours: s.businessHours, notes: s.notes, texts: s.texts, playbook: s.returnsPlaybook, limits: s.limits, delivery: deliveryOf(s) });
  useEffect(() => {
    api<Settings>(path).then((s) => { setSettings(s); setDraft(draftOf(s)); }, (e) => setError(e instanceof Error ? e.message : "Ayarlar yüklenemedi"));
  }, [path]);

  async function save(change: Record<string, unknown>, done: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const s = await api<Settings>(path, { method: "PATCH", body: change });
      setSettings(s); setDraft(draftOf(s)); setNotice(done);
    } catch (e) { setError(e instanceof Error ? e.message : "Ayar kaydedilemedi"); }
    finally { setBusy(false); }
  }

  function toggleBot(next: boolean) {
    if (!settings || busy) return;
    if (!next && !window.confirm("Lina kapatılsın mı? Müşterilere hiç cevap verilmeyecek; mesajlar panelde görünür ve konuşmaları siz devralıp yazabilirsiniz.")) return;
    void save({ botEnabled: next }, next ? "Lina açıldı." : "Lina kapatıldı.");
  }

  const hours = draft?.hours ?? null;
  const setHours = (h: Hours) => draft && setDraft({ ...draft, hours: h });
  const dirty = settings && draft && JSON.stringify(draft.hours) !== JSON.stringify(settings.businessHours);
  const notesDirty = settings && draft && draft.notes.trim() !== settings.notes;
  const textsDirty = settings && draft && JSON.stringify(draft.texts) !== JSON.stringify(settings.texts);
  const playbookDirty = settings && draft && draft.playbook.trim() !== settings.returnsPlaybook;
  const limitsDirty = settings && draft && JSON.stringify(draft.limits) !== JSON.stringify(settings.limits);
  const deliveryDirty = settings && draft && JSON.stringify(draft.delivery) !== JSON.stringify(deliveryOf(settings));
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
        {alerts.length > 0 && <a href="#celiski">Çelişkiler ({alerts.length})</a>}
        <a href="#mesai">Mesai saatleri</a>
        <a href="#teslimat">Teslimat süresi</a>
        <a href="#notlar">Lina'ya notlar</a>
        <a href="#metinler">Müşteriye giden metinler</a>
        <a href="#sinirlar">Cevap hızı ve sınırlar</a>
        <a href="#iade">İade el kitabı</a>
        {me && <a href="#team">Ekip</a>}
      </nav>
      <div className="settings-sections">
        {settings && draft && hours && <>
          <section id="lina" className="panel-card settings-card" aria-labelledby="bot-switch">
            <h2 id="bot-switch">Lina</h2>
            <p>{settings.botEnabled
              ? "Bir sorun görürseniz Lina'yı sağ üstteki anahtarla hemen durdurabilirsiniz. Mesajlar panelde görünmeye devam eder; konuşmaları devralıp müşteriye siz yazabilirsiniz."
              : "Müşteri mesajları panelde görünür ama cevaplanmaz. Hazır olunca anahtarı tekrar açın; açıldığında yalnızca yeni mesajlara cevap verilir."}</p>
          </section>

          {alerts.length > 0 && <section id="celiski" className="panel-card settings-card" aria-labelledby="alerts-title">
            <div><h2 id="alerts-title">Mağaza bilgilerinde çelişki</h2>
              <p className="hint">Sayfalarınız ya da politikalarınız aynı konuda farklı şey söylüyor; Lina bu konularda müşteriye rakam vermez, doğrusunu ekibe sorar. Siteyi düzeltin ya da doğrusunu "Lina'ya notlar"a yazın (notlar siteden önce gelir), sonra "Çözüldü" deyin.</p></div>
            <ul className="alert-list">
              {alerts.map((a) => <li key={a.id}>
                <div><strong>{a.topic}</strong><p>{a.description}</p></div>
                <button type="button" className="btn btn-secondary btn-sm" aria-label={`Çözüldü: ${a.topic}`} onClick={() => void resolveAlert(a)}>Çözüldü</button>
              </li>)}
            </ul>
          </section>}

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

          <section id="teslimat" className="panel-card settings-card" aria-labelledby="delivery-title">
            <div><h2 id="delivery-title">Teslimat süresi</h2><p className="hint">Mağazanın katı kuralı: siparişlerin hepsi sipariş tarihinden itibaren bu süre içinde teslim edilir. Lina müşteriye her yerde yalnızca bunu söyler (sayfalarınız başka süre yazsa da), sipariş kartında kalan süreyi görür ve süre aşılırsa ekibe gecikme bildirimi düşer.</p></div>
            <div className="switch-row">
              <div><strong>Teslimat süresi kuralı</strong>
                <p className="hint">{draft.delivery.on ? "Açık: Lina bu süreyi söyler." : "Kapalı: Lina süreyi mağaza sayfalarından okur."}</p></div>
              <Switch checked={draft.delivery.on} label="Teslimat süresi kuralı" onChange={(on) => setDraft({ ...draft, delivery: { ...draft.delivery, on } })} />
            </div>
            {draft.delivery.on && <div className="field-row">
              <div className="field"><label htmlFor="delivery-min">En az (gün)</label><input id="delivery-min" type="number" inputMode="numeric" min={settings.deliveryRange[0]} max={settings.deliveryRange[1]} value={draft.delivery.min}
                onChange={(e) => setDraft({ ...draft, delivery: { ...draft.delivery, min: e.target.value === "" ? NaN : Number(e.target.value) } })} /></div>
              <div className="field"><label htmlFor="delivery-max">En çok (gün)</label><input id="delivery-max" type="number" inputMode="numeric" min={settings.deliveryRange[0]} max={settings.deliveryRange[1]} value={draft.delivery.max}
                onChange={(e) => setDraft({ ...draft, delivery: { ...draft.delivery, max: e.target.value === "" ? NaN : Number(e.target.value) } })} /></div>
            </div>}
            <div><button type="button" className="btn btn-primary" disabled={busy || !deliveryDirty}
              onClick={() => void save({ deliveryDays: draft.delivery.on ? { min: draft.delivery.min, max: draft.delivery.max } : null }, draft.delivery.on ? "Teslimat süresi kaydedildi." : "Teslimat süresi kuralı kapatıldı.")}>Teslimat süresini kaydet</button></div>
          </section>

          <section id="notlar" className="panel-card settings-card" aria-labelledby="notes-title">
            <div><h2 id="notes-title">Lina'ya notlar</h2><p className="hint">Sitenizde olmayan geçici bilgileri yazın (örnek: "Bu hafta kargoda gecikme var", "Pazartesi kapalıyız"). Lina bunları her soruda okur; siteyle çelişirse notlar geçerlidir.</p></div>
            <textarea aria-label="Lina'ya notlar" rows={6} maxLength={8000} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            <div><button type="button" className="btn btn-primary" disabled={busy || !notesDirty} onClick={() => void save({ notes: draft.notes }, "Notlar kaydedildi; Lina bir sonraki mesajda okur.")}>Notları kaydet</button></div>
          </section>

          <section id="metinler" className="panel-card settings-card" aria-labelledby="texts-title">
            <div><h2 id="texts-title">Müşteriye giden metinler</h2><p className="hint">Lina yazıyı yapay zekâ olmadan, hazır metinle gönderdiği iki durum. Boş bırakırsanız hazır metin gider (müşteri İngilizce yazdıysa İngilizcesi). Kendi metninizi yazarsanız her dilde o gider.</p></div>
            <div className="field"><label htmlFor="text-unsupported">Sesli mesaj, video ya da belge gelince</label>
              <textarea id="text-unsupported" rows={2} maxLength={500} placeholder={settings.defaultTexts.unsupported} value={draft.texts.unsupported} onChange={(e) => setDraft({ ...draft, texts: { ...draft.texts, unsupported: e.target.value } })} /></div>
            <div className="field"><label htmlFor="text-failure">Teknik bir hata olup cevap verilemeyince</label>
              <textarea id="text-failure" rows={2} maxLength={500} placeholder={settings.defaultTexts.failure} value={draft.texts.failure} onChange={(e) => setDraft({ ...draft, texts: { ...draft.texts, failure: e.target.value } })} />
              <p className="hint">Hazır metin mesai dışında "kısa süre içinde" demez, ekibin ne zaman döneceğini söyler; kendi metninizde bunu siz düşünün. Bu durumda konuşma ekibe de devredilir.</p></div>
            <div><button type="button" className="btn btn-primary" disabled={busy || !textsDirty} onClick={() => void save({ texts: draft.texts }, "Metinler kaydedildi.")}>Metinleri kaydet</button></div>
          </section>

          <section id="sinirlar" className="panel-card settings-card" aria-labelledby="limits-title">
            <div><h2 id="limits-title">Cevap hızı ve sınırlar</h2><p className="hint">Lina'nın ne kadar beklediği ve günde en fazla kaç mesaja cevap vereceği.</p></div>
            <div className="limit-grid">
              {LIMIT_FIELDS.map((f) => {
                const [min, max] = settings.limitRanges[f.key];
                return <div className="field" key={f.key}>
                  <label htmlFor={`limit-${f.key}`}>{f.label}</label>
                  <div className="limit-input"><input id={`limit-${f.key}`} type="number" inputMode="numeric" min={min} max={max} step={1} value={draft.limits[f.key]}
                    onChange={(e) => setDraft({ ...draft, limits: { ...draft.limits, [f.key]: e.target.value === "" ? NaN : Number(e.target.value) } })} /><span className="hint">{f.unit}</span></div>
                  <p className="hint">{f.hint} ({min}–{max})</p>
                </div>;
              })}
            </div>
            <div><button type="button" className="btn btn-primary" disabled={busy || !limitsDirty} onClick={() => void save({ ...draft.limits }, "Sınırlar kaydedildi.")}>Sınırları kaydet</button></div>
          </section>

          <section id="iade" className="panel-card settings-card" aria-labelledby="playbook-title">
            <div><h2 id="playbook-title">İade el kitabı</h2><p className="hint">İade uzmanının mağazanıza özel talimatları: iade ve değişimde nasıl davranılacağı, neye izin verilip neye verilmediği. Boş bırakırsanız uzman politika sayfalarına göre çalışır. İade sisteminin kendisine (iade paneli) dokunulmaz.</p></div>
            <textarea aria-label="İade el kitabı" rows={10} maxLength={20000} value={draft.playbook} onChange={(e) => setDraft({ ...draft, playbook: e.target.value })} />
            <div><button type="button" className="btn btn-primary" disabled={busy || !playbookDirty} onClick={() => void save({ returnsPlaybook: draft.playbook }, "İade el kitabı kaydedildi.")}>El kitabını kaydet</button></div>
          </section>
        </>}
        {me && <TeamSection store={store} userId={me.user.id} />}
      </div>
    </div>
  </main>;
}
