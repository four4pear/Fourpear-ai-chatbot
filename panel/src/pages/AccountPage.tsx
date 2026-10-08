import { useEffect, useState, type FormEvent } from "react";
import { api, MIN_PASSWORD_LENGTH } from "../api";
import { useSession } from "../session";

/** Hesabım: kendi şifreni değiştir. Başka cihazlardaki oturumlar kapanır, bu oturum açık kalır. */
export function AccountPage() {
  const { me, errorMessage } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => { document.title = "Hesabım · Lina Panel"; }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(""); setDone(false);
    if (next !== again) { setError("Yeni şifre iki kez aynı yazılmalı."); return; }
    setBusy(true);
    try {
      await api("/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      setDone(true); setCurrent(""); setNext(""); setAgain("");
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }

  return <main className="page account-page">
    <div><p className="hint">{me?.user.email}</p><h1>Hesabım</h1></div>
    <section className="panel-card settings-card" aria-labelledby="password-title">
      <div><h2 id="password-title">Şifreyi değiştir</h2><p className="hint">Şifre değişince diğer cihazlardaki oturumlar kapanır; burada açık kalırsınız. Şifre en az {MIN_PASSWORD_LENGTH} karakter olmalı.</p></div>
      <form className="account-form" onSubmit={submit}>
        <div className="field"><label htmlFor="pw-current">Mevcut şifre</label><input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></div>
        <div className="field"><label htmlFor="pw-new">Yeni şifre</label><input id="pw-new" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} required /></div>
        <div className="field"><label htmlFor="pw-again">Yeni şifre (tekrar)</label><input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></div>
        {error && <p role="alert" className="test-error">{error}</p>}
        {done && <p className="waiting-notice" role="status">Şifreniz değiştirildi.</p>}
        <div><button type="submit" className="btn btn-primary" disabled={busy || !current || !next || !again}>Şifreyi değiştir</button></div>
      </form>
    </section>
  </main>;
}
