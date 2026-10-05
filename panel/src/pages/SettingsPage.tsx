import { useEffect, useState } from "react";
import { api, type Membership } from "../api";

/** Ayarlar: şimdilik Lina'yı açıp kapatma (acil durdurma). Diğer ayarlar sırayla eklenecek. */
export function SettingsPage({ store }: { store: Membership }) {
  const [botEnabled, setBotEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/tenants/${store.tenantId}/settings`;

  useEffect(() => {
    api<{ botEnabled: boolean }>(path).then((s) => setBotEnabled(s.botEnabled), (e) => setError(e instanceof Error ? e.message : "Ayarlar yüklenemedi"));
  }, [path]);

  async function toggle() {
    if (botEnabled === null || busy) return;
    const next = !botEnabled;
    if (!next && !window.confirm("Lina kapatılsın mı? Müşterilere hiç cevap verilmeyecek; mesajlar panelde görünür ve konuşmaları siz devralıp yazabilirsiniz.")) return;
    setBusy(true); setError("");
    try { setBotEnabled((await api<{ botEnabled: boolean }>(path, { method: "PATCH", body: { botEnabled: next } })).botEnabled); }
    catch (e) { setError(e instanceof Error ? e.message : "Ayar kaydedilemedi"); }
    finally { setBusy(false); }
  }

  return <main className="page">
    <p className="hint">{store.name}</p>
    <h1>Ayarlar</h1>
    {error && <p role="alert" className="test-error">{error}</p>}
    <section className="panel-card settings-card" aria-labelledby="bot-switch">
      <h2 id="bot-switch">Lina</h2>
      {botEnabled === null && !error && <p className="hint" role="status">Yükleniyor…</p>}
      {botEnabled !== null && <>
        <p role="status"><strong>{botEnabled ? "Lina açık: müşterilere cevap veriyor." : "Lina kapalı: hiçbir müşteriye cevap vermiyor."}</strong></p>
        <p className="hint">{botEnabled
          ? "Bir sorun görürseniz Lina'yı buradan hemen durdurabilirsiniz. Mesajlar panelde görünmeye devam eder; konuşmaları devralıp müşteriye siz yazabilirsiniz."
          : "Müşteri mesajları panelde görünür ama cevaplanmaz. Hazır olunca tekrar açın; açıldığında yalnızca yeni mesajlara cevap verilir."}</p>
        <button className={`btn ${botEnabled ? "btn-secondary" : "btn-primary"}`} disabled={busy} onClick={() => void toggle()}>
          {botEnabled ? "Lina'yı kapat" : "Lina'yı aç"}
        </button>
      </>}
    </section>
    <p className="hint">Mesai saatleri, Lina'ya notlar, sabit metinler ve ekip yönetimi sonraki adımlarda burada olacak.</p>
  </main>;
}
