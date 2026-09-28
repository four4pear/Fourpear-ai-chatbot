import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, MIN_PASSWORD_LENGTH, type Me, type TokenInfo } from "../api";
import { Link, navigate } from "../router";
import { useSession } from "../session";

const roleLabel = (role: TokenInfo["role"]) => (role === "owner" ? "mağaza sahibi" : "çalışan");

/**
 * Davet (/davet/:token) ve şifre belirleme (/sifre/:token) sayfası.
 * - Yeni kişi: ad + şifre ile hesap açar.
 * - Hesabı olan kişi: kendi şifresiyle kabul eder (link ele geçirilse bile başkası giremez).
 * - O hesapla zaten oturum açıksa: tek tıkla katılır.
 */
export function TokenPage({ token }: { token: string }) {
  const { me, setMe, errorMessage } = useSession();
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<TokenInfo>(`/tokens/${encodeURIComponent(token)}`)
      .then((i) => !cancelled && setInfo(i))
      .catch((err) => !cancelled && setLoadError(err instanceof ApiError ? err.message : "Link kontrol edilemedi."));
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    document.title = `${info?.kind === "reset" ? "Şifre belirle" : "Davet"} · Lina Panel`;
  }, [info]);

  if (loadError) {
    return (
      <Card title="Link kullanılamıyor">
        <p>{loadError}</p>
        <p className="hint">Yeni bir link için mağaza sahibinize ya da yöneticinize başvurun.</p>
        <Link to="/giris" className="btn btn-secondary">
          Giriş sayfasına git
        </Link>
      </Card>
    );
  }
  if (!info) {
    return (
      <Card title="Link kontrol ediliyor…">
        <p className="hint" role="status">
          Lütfen bekleyin.
        </p>
      </Card>
    );
  }

  const mode =
    info.kind === "reset"
      ? "reset"
      : me && me.user.email === info.email
        ? "joinAsCurrent"
        : info.hasAccount
          ? "existing"
          : "new";
  const setsPassword = mode === "reset" || mode === "new";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "new" && !name.trim()) return setError("Adınızı yazın.");
    if (setsPassword && password.length < MIN_PASSWORD_LENGTH) {
      return setError(`Şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalı.`);
    }
    if (setsPassword && password !== password2) return setError("Şifreler birbirini tutmuyor.");

    setBusy(true);
    try {
      const body = mode === "new" ? { name, password } : mode === "joinAsCurrent" ? {} : { password };
      const result = await api<Me>(`/tokens/${encodeURIComponent(token)}/accept`, { method: "POST", body });
      setMe(result);
      // Adres çubuğundan gizli anahtarı da kaldırır.
      navigate(info!.kind === "invite" && info!.tenantSlug ? `/m/${info!.tenantSlug}/bekleyenler` : "/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const title = mode === "reset" ? "Yeni şifre belirleyin" : `${info.tenantName} ekibine katılın`;
  const intro =
    mode === "reset" ? (
      <p>
        <strong>{info.email}</strong> hesabı için yeni şifrenizi belirleyin.
      </p>
    ) : mode === "new" ? (
      <p>
        <strong>{info.email}</strong> adresi {roleLabel(info.role)} olarak davet edildi. Hesabınızı oluşturun.
      </p>
    ) : mode === "existing" ? (
      <p>
        <strong>{info.email}</strong> için zaten bir hesabınız var. Katılmak için şifrenizi girin.
      </p>
    ) : (
      <p>
        {me!.user.name}, {info.tenantName} ekibine {roleLabel(info.role)} olarak katılmak üzeresiniz.
      </p>
    );

  return (
    <Card title={title}>
      {intro}
      {me && me.user.email !== info.email && (
        <div className="notice">
          Şu an {me.user.email} olarak oturum açıksınız; bu link {info.email} için.
        </div>
      )}
      <form onSubmit={submit} noValidate>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        {mode === "new" && (
          <div className="field">
            <label htmlFor="name">Adınız</label>
            <input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        {mode !== "joinAsCurrent" && (
          <div className="field">
            <label htmlFor="password">{setsPassword ? "Şifre" : "Şifreniz"}</label>
            <input
              id="password"
              type="password"
              autoComplete={setsPassword ? "new-password" : "current-password"}
              aria-describedby={setsPassword ? "password-hint" : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {setsPassword && (
              <span id="password-hint" className="hint">
                En az {MIN_PASSWORD_LENGTH} karakter.
              </span>
            )}
          </div>
        )}
        {setsPassword && (
          <div className="field">
            <label htmlFor="password2">Şifre (tekrar)</label>
            <input
              id="password2"
              type="password"
              autoComplete="new-password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
            />
          </div>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy
            ? "Kaydediliyor…"
            : mode === "reset"
              ? "Şifremi kaydet"
              : mode === "new"
                ? "Hesabımı oluştur ve katıl"
                : "Katıl"}
        </button>
      </form>
    </Card>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            L
          </span>
          Lina Panel
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}
