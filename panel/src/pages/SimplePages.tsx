import type { Me } from "../api";
import { Link } from "../router";
import type { SectionKey } from "../Shell";

const COMING: Record<SectionKey, { title: string; text: string }> = {
  bekleyenler: {
    title: "Bekleyenler",
    text: "Lina'nın ekibe devrettiği konuşmalar burada, en uzun bekleyen en üstte listelenecek.",
  },
  sohbetler: { title: "Tüm sohbetler", text: "Tüm WhatsApp konuşmaları burada görünecek." },
  istatistik: { title: "İstatistik", text: "Konuşma sayıları, devir oranı, sık sorulan konular ve paket kullanımı burada olacak." },
  ayarlar: {
    title: "Ayarlar",
    text: "Mesai saatleri, Lina'ya notlar, bilgi kaynakları, sabit metinler ve ekip burada olacak.",
  },
};

/** Bu adımda henüz yapılmamış bölümler: ne geleceğini açıkça söyler. */
export function ComingSoon({ section }: { section: SectionKey }) {
  const { title, text } = COMING[section];
  return (
    <main className="page">
      <h1>{title}</h1>
      <div className="panel-card">
        <p style={{ margin: 0 }}>{text}</p>
        <p className="hint" style={{ margin: "8px 0 0" }}>
          Bu ekran bir sonraki adımda hazırlanacak.
        </p>
      </div>
    </main>
  );
}

export function AdminPage({ me }: { me: Me }) {
  return (
    <main className="page">
      <h1>Tüm mağazalar</h1>
      <div className="panel-card">
        {me.memberships.length === 0 ? (
          <p style={{ margin: 0 }}>Henüz mağaza yok.</p>
        ) : (
          <ul className="store-list">
            {me.memberships.map((m) => (
              <li key={m.slug}>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                <Link to={`/m/${m.slug}/bekleyenler`}>Paneli aç</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

export function Forbidden() {
  return (
    <main className="page">
      <h1>Bu sayfayı görme yetkiniz yok</h1>
      <div className="panel-card">
        <p style={{ margin: 0 }}>Bu bölümü yalnızca mağaza sahibi görebilir.</p>
      </div>
    </main>
  );
}

export function NotFound() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <h1>Sayfa bulunamadı</h1>
        <p>Aradığınız sayfa yok ya da erişiminiz bulunmuyor.</p>
        <Link to="/" className="btn btn-secondary">
          Ana sayfaya dön
        </Link>
      </div>
    </main>
  );
}

export function NoStore({ me }: { me: Me }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <h1>Henüz bir mağazaya eklenmediniz</h1>
        <p>
          {me.user.email} hesabı bir mağazaya bağlı değil. Mağaza sahibinizden size bir davet linki göndermesini isteyin.
        </p>
      </div>
    </main>
  );
}
