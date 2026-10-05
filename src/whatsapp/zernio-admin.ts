import { DEFAULT_ZERNIO_API, ZernioApiError } from "./zernio.js";

type Opts = { baseUrl?: string; fetchImpl?: typeof fetch };

async function call(path: string, apiKey: string, opts: Opts, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const base = (opts.baseUrl ?? DEFAULT_ZERNIO_API).replace(/\/+$/, "");
  const res = await (opts.fetchImpl ?? fetch)(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new ZernioApiError(res.status, text);
  return text ? JSON.parse(text) : {};
}

export type ZernioAccount = { id: string; platform: string; name: string };

/** Anahtarın görebildiği hesaplar; yanıt biçimi belgede ayrıntılı değil, bu yüzden esnek okunur. */
export async function listZernioAccounts(apiKey: string, opts: Opts = {}): Promise<ZernioAccount[]> {
  const data = (await call("/accounts", apiKey, opts)) as Record<string, unknown>;
  const list = Array.isArray(data) ? data : (data.accounts ?? data.data ?? []);
  if (!Array.isArray(list)) return [];
  return list.flatMap((a: Record<string, unknown>) => {
    const id = String(a._id ?? a.id ?? a.accountId ?? "");
    if (!id) return [];
    return [{ id, platform: String(a.platform ?? "").toLowerCase(), name: String(a.displayName ?? a.username ?? a.name ?? a.phoneNumber ?? "") }];
  });
}

/** Zernio'ya "şu adrese mesaj olaylarını şu sırla imzalayarak gönder" der. */
export async function registerZernioWebhook(apiKey: string, opts: Opts & { url: string; secret: string }): Promise<void> {
  await call("/webhooks/settings", apiKey, opts, {
    method: "POST",
    body: { name: "Lina", url: opts.url, events: ["message.received"], secret: opts.secret },
  });
}
