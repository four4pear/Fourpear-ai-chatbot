import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

// Panelde az sayfa var; küçük bir yönlendirici yeterli (tarayıcının geçmiş API'si üzerinde).

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") window.addEventListener("popstate", notify);

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Geçerli adres (yol + sorgu); değişince bileşen yeniden çizilir. */
export function useLocation(): { path: string; search: URLSearchParams } {
  const href = useSyncExternalStore(subscribe, () => location.pathname + location.search);
  const url = new URL(href, "http://x");
  return { path: url.pathname, search: url.searchParams };
}

/** "/m/:slug/:section" gibi bir kalıbı yolla eşleştirir; eşleşmezse null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/** Sayfayı yeniden yüklemeden geçiş yapan bağlantı (Ctrl/Cmd+tık yeni sekmede açılır). */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}

export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

/** Girişten sonra dönülecek adres yalnızca bu sitenin içi olabilir (başka siteye yönlendirme açığı olmasın). */
export function safeReturnPath(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}
