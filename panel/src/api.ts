export type Role = "owner" | "agent";

export type Membership = { tenantId: string; slug: string; name: string; role: Role };

export type Me = {
  user: { id: string; email: string; name: string; isSuperAdmin: boolean };
  memberships: Membership[];
};

export type TokenInfo = {
  kind: "invite" | "reset";
  email: string;
  tenantName: string | null;
  tenantSlug: string | null;
  role: Role | null;
  hasAccount: boolean;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Bekleyen iş sayısı değişmiş olabilir (soru cevaplandı, talep tamamlandı, konuşma devralındı): menüdeki rozet hemen yenilensin. */
export const WAITING_CHANGED = "lina:waiting-changed";
export const waitingChanged = () => window.dispatchEvent(new Event(WAITING_CHANGED));

/** Sunucudan canlı olay geldi (yeni devir, bildirim, mesaj…): açık listeler ve konuşma yenilensin. */
export const LIVE_EVENT = "lina:live";
export const liveChanged = () => window.dispatchEvent(new Event(LIVE_EVENT));

let onUnauthorized: (() => void) | null = null;
/** Oturum düştüğünde (herhangi bir istekte 401) çağrılır; SessionProvider girişe döndürür. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

/** Sunucu API'sine istek. Hata mesajları sunucudan Türkçe gelir. */
export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body === undefined ? undefined : { "content-type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "same-origin",
      signal: opts.signal,
    });
  } catch (err) {
    // Bilerek iptal edilen istek bağlantı hatası değildir; çağıran taraf ayırt eder.
    if (opts.signal?.aborted) throw err;
    throw new ApiError(0, "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.");
  }
  let data: { error?: string } & Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    // Gövde JSON değilse aşağıdaki genel mesaj kullanılır.
  }
  // Giriş ve davet uçlarındaki 401 "şifre yanlış" demektir; diğerlerinde oturum düşmüştür.
  if (res.status === 401 && !path.startsWith("/auth/") && !path.startsWith("/tokens/") && path !== "/me") onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, data.error ?? "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.");
  return data as T;
}

export const MIN_PASSWORD_LENGTH = 10;
