// Yeni iş gelince ekibi uyaran ses ve tarayıcı bildirimi. Tarayıcı ayarı yalnızca bu cihazda kalır
// (localStorage): kişisel bir tercih, mağaza ayarı değil.
const KEY = "lina:alerts";

/** Uyarılar açık mı? Varsayılan açık; kullanıcı zil düğmesiyle kapatır. */
export function alertsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAlerts(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* özel pencere ya da kapalı depolama: tercih bu oturumda kalmaz */
  }
}

let audio: AudioContext | null = null;

/** İki kısa nota ("tin-tın"); ekran okuyucuyu ve sayfayı bozmaz. */
export function playBeep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    void audio.resume();
    const start = audio.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      const at = start + i * 0.22;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      osc.connect(gain).connect(audio!.destination);
      osc.start(at);
      osc.stop(at + 0.32);
    });
  } catch {
    /* ses çalınamazsa panel yine de çalışır */
  }
}

/** Tarayıcı bildirimi için izin ister (yalnızca kullanıcının tıklamasından çağrılır). */
export function askNotificationPermission() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    /* izin penceresi açılamadı */
  }
}

/** Başka sekmedeyken ya da pencere arka plandayken masaüstü bildirimi (içinde müşteri bilgisi yok). */
function showBrowserNotification(added: number, total: number) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const n = new Notification("Lina: yeni iş geldi", {
      body: added > 1 ? `${added} yeni iş. Toplam ${total} iş bekliyor.` : `Toplam ${total} iş bekliyor.`,
      tag: "lina-waiting",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* bildirim gösterilemedi */
  }
}

/** Bekleyen iş sayısı arttı: ses + (arka plandaysa) tarayıcı bildirimi. */
export function alertNewWork(added: number, total: number) {
  if (!alertsOn()) return;
  playBeep();
  showBrowserNotification(added, total);
}
