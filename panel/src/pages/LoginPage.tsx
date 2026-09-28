import { useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api";
import { navigate, safeReturnPath, useLocation } from "../router";
import { useSession } from "../session";

export function LoginPage() {
  const { setMe, errorMessage } = useSession();
  const { search } = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Giriş · Lina Panel";
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api<Me>("/auth/login", { method: "POST", body: { email, password } });
      setMe(me);
      navigate(safeReturnPath(search.get("sonra")), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            L
          </span>
          Lina Panel
        </div>
        <h1>Giriş yapın</h1>
        <form onSubmit={submit}>
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          <div className="field">
            <label htmlFor="email">E-posta</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Şifre</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Giriş yapılıyor…" : "Giriş yap"}
          </button>
        </form>
        <p className="hint">Şifrenizi mi unuttunuz? Mağaza sahibinizden yeni bir şifre linki isteyin.</p>
      </div>
    </main>
  );
}
