import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Me } from "./api";

type Session = {
  me: Me | null;
  loading: boolean;
  setMe: (me: Me | null) => void;
  logout: () => Promise<void>;
  /** Oturum düşmüşse (401) girişe döndürür; diğer hataları mesaj olarak verir. */
  errorMessage: (err: unknown) => string;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<Me>("/me")
      .then((m) => !cancelled && setMe(m))
      .catch(() => !cancelled && setMe(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setMe(null);
    }
  }, []);

  const errorMessage = useCallback((err: unknown) => {
    if (err instanceof ApiError) {
      if (err.status === 401) setMe(null);
      return err.message;
    }
    return "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.";
  }, []);

  return <SessionContext.Provider value={{ me, loading, setMe, logout, errorMessage }}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession, SessionProvider içinde kullanılmalı");
  return s;
}

const LAST_STORE_KEY = "lina.lastStore";

/** Son açılan mağaza (tarayıcıda; erişilemezse sessizce yok sayılır). */
export function rememberStore(slug: string) {
  try {
    localStorage.setItem(LAST_STORE_KEY, slug);
  } catch {
    // Gizli sekme vb.
  }
}

export function lastStore(): string | null {
  try {
    return localStorage.getItem(LAST_STORE_KEY);
  } catch {
    return null;
  }
}
