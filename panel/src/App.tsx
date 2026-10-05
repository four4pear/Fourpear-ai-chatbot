import { TestPage } from "./pages/TestPage";
import { WaitingPage } from "./pages/WaitingPage";
import { ConversationPage, ConversationsPage } from "./pages/ConversationsPage";
import { UsagePage } from "./pages/UsagePage";
import { SettingsPage } from "./pages/SettingsPage";
import type { Me } from "./api";
import { AdminPage, ComingSoon, Forbidden, NoStore, NotFound } from "./pages/SimplePages";
import { LoginPage } from "./pages/LoginPage";
import { TokenPage } from "./pages/TokenPage";
import { matchPath, Redirect, useLocation } from "./router";
import { lastStore, SessionProvider, useSession } from "./session";
import { SECTIONS, Shell, type SectionKey } from "./Shell";

export function App() {
  return (
    <SessionProvider>
      <Routes />
    </SessionProvider>
  );
}

/** Oturum açınca gidilecek yer: son açılan mağaza, yoksa ilki; mağazası olmayan yönetici tüm mağazalara. */
function homePath(me: Me): string | null {
  const store = me.memberships.find((m) => m.slug === lastStore()) ?? me.memberships[0];
  if (store) return `/m/${store.slug}/bekleyenler`;
  return me.user.isSuperAdmin ? "/yonetici" : null;
}

function Routes() {
  const { me, loading } = useSession();
  const { path, search } = useLocation();

  // Davet ve şifre linkleri oturumsuz da açılır.
  const tokenRoute = matchPath("/davet/:token", path) ?? matchPath("/sifre/:token", path);
  if (tokenRoute) return <TokenPage key={tokenRoute.token} token={tokenRoute.token!} />;

  if (loading) {
    return (
      <div className="splash" role="status">
        Yükleniyor…
      </div>
    );
  }

  if (path === "/giris") return me ? <Redirect to="/" /> : <LoginPage />;
  if (!me) {
    const back = path === "/" ? "" : `?sonra=${encodeURIComponent(path + (search.size ? `?${search}` : ""))}`;
    return <Redirect to={`/giris${back}`} />;
  }

  if (path === "/") {
    const home = homePath(me);
    return home ? <Redirect to={home} /> : <NoStore me={me} />;
  }

  if (path === "/yonetici") {
    if (!me.user.isSuperAdmin) return <NotFound />;
    return (
      <Shell me={me} store={null} active="yonetici">
        <AdminPage me={me} />
      </Shell>
    );
  }

  const chat = matchPath("/m/:slug/sohbetler/:conversationId", path);
  if (chat) {
    const store = me.memberships.find((s) => s.slug === chat.slug);
    if (!store) return <NotFound />;
    return (
      <Shell me={me} store={store} active="sohbetler">
        <ConversationPage key={chat.conversationId} store={store} conversationId={chat.conversationId!} userId={me.user.id} />
      </Shell>
    );
  }

  const m = matchPath("/m/:slug/:section", path) ?? matchPath("/m/:slug", path);
  if (m) {
    const store = me.memberships.find((s) => s.slug === m.slug);
    const section = SECTIONS.find((s) => s.key === (m.section ?? "bekleyenler"));
    if (!store || !section) return <NotFound />;
    if (!m.section) return <Redirect to={`/m/${store.slug}/bekleyenler`} />;
    return (
      <Shell me={me} store={store} active={section.key}>
        {section.ownerOnly && store.role !== "owner" ? (
          <Forbidden />
        ) : section.key === "test" ? (
          <TestPage key={store.tenantId} store={store} />
        ) : section.key === "bekleyenler" ? (
          <WaitingPage key={store.tenantId} store={store} />
        ) : section.key === "istatistik" ? (
          <UsagePage key={store.tenantId} store={store} />
        ) : section.key === "ayarlar" ? (
          <SettingsPage key={store.tenantId} store={store} />
        ) : section.key === "sohbetler" ? (
          <ConversationsPage key={store.tenantId} store={store} />
        ) : (
          <ComingSoon section={section.key as SectionKey} />
        )}
      </Shell>
    );
  }

  return <NotFound />;
}
