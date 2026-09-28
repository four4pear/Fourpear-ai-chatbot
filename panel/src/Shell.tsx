import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Me, Membership } from "./api";
import { ChartIcon, ChatIcon, InboxIcon, SettingsIcon, ShieldIcon } from "./icons";
import { Link, navigate } from "./router";
import { rememberStore, useSession } from "./session";

export type SectionKey = "bekleyenler" | "sohbetler" | "istatistik" | "ayarlar";

export const SECTIONS: { key: SectionKey; label: string; ownerOnly: boolean; Icon: () => ReactNode }[] = [
  { key: "bekleyenler", label: "Bekleyenler", ownerOnly: false, Icon: InboxIcon },
  { key: "sohbetler", label: "Tüm sohbetler", ownerOnly: false, Icon: ChatIcon },
  { key: "istatistik", label: "İstatistik", ownerOnly: true, Icon: ChartIcon },
  { key: "ayarlar", label: "Ayarlar", ownerOnly: true, Icon: SettingsIcon },
];

/** Kullanıcının bu mağazada görebileceği bölümler (çalışan: sadece sohbetler). */
export const visibleSections = (store: Membership) => SECTIONS.filter((s) => !s.ownerOnly || store.role === "owner");

type Active = SectionKey | "yonetici" | null;

export function Shell({ me, store, active, children }: { me: Me; store: Membership | null; active: Active; children: ReactNode }) {
  const sections = store ? visibleSections(store) : [];
  const title = active === "yonetici" ? "Tüm mağazalar" : SECTIONS.find((s) => s.key === active)?.label;

  useEffect(() => {
    if (store) rememberStore(store.slug);
    document.title = [title, store?.name, "Lina Panel"].filter(Boolean).join(" · ");
  }, [store, title]);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Ana menü">
        <span className="brand-mark" aria-hidden="true">
          L
        </span>
        {sections.map(({ key, label, Icon }) => (
          <Link
            key={key}
            to={`/m/${store!.slug}/${key}`}
            className="rail-link"
            aria-label={label}
            title={label}
            aria-current={active === key ? "page" : undefined}
          >
            <Icon />
          </Link>
        ))}
        {me.user.isSuperAdmin && (
          <Link
            to="/yonetici"
            className="rail-link"
            aria-label="Tüm mağazalar (yönetici)"
            title="Tüm mağazalar"
            aria-current={active === "yonetici" ? "page" : undefined}
          >
            <ShieldIcon />
          </Link>
        )}
        <span className="rail-spacer" />
        <UserMenu me={me} />
      </nav>

      <div className="main">
        <header className="topbar">
          <StoreSwitcher me={me} store={store} active={active} />
          {store && (
            <span className="role-tag">{me.user.isSuperAdmin ? "Yönetici" : store.role === "owner" ? "Sahip" : "Çalışan"}</span>
          )}
          <span style={{ flexGrow: 1 }} />
          <div className="mobile-only">
            <UserMenu me={me} />
          </div>
        </header>
        {children}
      </div>

      {sections.length > 0 && (
        <nav className="bottom-nav" aria-label="Alt menü">
          {sections.map(({ key, label, Icon }) => (
            <Link key={key} to={`/m/${store!.slug}/${key}`} aria-current={active === key ? "page" : undefined}>
              <Icon />
              {label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

function StoreSwitcher({ me, store, active }: { me: Me; store: Membership | null; active: Active }) {
  if (me.memberships.length === 0) return null;
  const section = active && active !== "yonetici" ? active : "bekleyenler";
  return (
    <div className="store-switch">
      <label htmlFor="store-select" className="sr-only">
        Mağaza
      </label>
      <select
        id="store-select"
        value={store?.slug ?? ""}
        onChange={(e) => {
          const next = me.memberships.find((m) => m.slug === e.target.value);
          if (!next) return;
          // Çalışan olduğu mağazada sahip sayfaları yok: bekleyenlere geçer.
          const allowed = visibleSections(next).some((s) => s.key === section);
          navigate(`/m/${next.slug}/${allowed ? section : "bekleyenler"}`);
        }}
      >
        {!store && (
          <option value="" disabled>
            Mağaza seçin
          </option>
        )}
        {me.memberships.map((m) => (
          <option key={m.slug} value={m.slug}>
            {m.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toLocaleUpperCase("tr-TR"))
    .join("");
}

function UserMenu({ me }: { me: Me }) {
  const { logout } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="avatar"
        aria-label={`Hesap: ${me.user.name}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {initials(me.user.name)}
      </button>
      {open && (
        <div className="user-menu-panel">
          <div className="who">
            <span>{me.user.name}</span>
            <span>{me.user.email}</span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-block"
            onClick={async () => {
              await logout();
              navigate("/giris", { replace: true });
            }}
          >
            Çıkış yap
          </button>
        </div>
      )}
    </div>
  );
}
