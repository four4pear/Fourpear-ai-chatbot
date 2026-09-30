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
  if (!res.ok) throw new ApiError(res.status, data.error ?? "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.");
  return data as T;
}

export const MIN_PASSWORD_LENGTH = 10;
