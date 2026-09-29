import type { ReturnRequestInfo, ReturnsProvider } from "./provider.js";

/**
 * Kolay İade paneli (iade.betulsaday.com) MCP bağlantısı: JSON-RPC 2.0, oturumsuz HTTP,
 * `X-Iade-Key` başlığıyla. Panelde 20 araç var; Lina yalnızca aşağıdaki iki okuma aracını
 * çağırabilir. Kupon, e-posta, durum değiştirme, ayar ve SQL araçları bu koddan hiç çağrılamaz.
 */
export const ALLOWED_TOOLS = ["talep_ara", "talep_detay"] as const;
type AllowedTool = (typeof ALLOWED_TOOLS)[number];

/** Anahtarla görünmemesi gereken araçlar (bağlantı testi uyarır). */
export const DANGEROUS_TOOLS = [
  "sql", "kupon_olustur", "kupon_iptal", "mail_gonder", "durum_degistir", "ayar_yaz", "talep_guncelle",
  "urun_guncelle", "kargo_kodu_ata", "not_ekle", "talep_olustur", "iyzico_odeme", "siparis_ara", "ayarlar_oku",
];

type Fetch = typeof fetch;

export class McpClient {
  private seq = 0;
  private initialized = false;

  constructor(private opts: { url: string; key: string; fetch?: Fetch; timeoutMs?: number }) {}

  private async rpc(method: string, params: Record<string, unknown>, notify = false): Promise<unknown> {
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++this.seq, method, params };
    const res = await (this.opts.fetch ?? fetch)(this.opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-iade-key": this.opts.key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    if (notify) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`İade sistemi HTTP ${res.status}`);
    // Cevap düz JSON ya da SSE ("data: {...}") olabilir.
    const raw = text.trim().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5))
          .join("");
    const parsed = JSON.parse(raw) as { result?: unknown; error?: { message?: string } };
    if (parsed.error) throw new Error(`İade sistemi hatası: ${parsed.error.message ?? "bilinmiyor"}`);
    return parsed.result;
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "lina", version: "1.0" },
    });
    await this.rpc("notifications/initialized", {}, true);
    this.initialized = true;
  }

  /** Anahtarın görebildiği araçlar (bağlantı testi için). */
  async listTools(): Promise<string[]> {
    await this.ensureInitialized();
    const result = (await this.rpc("tools/list", {})) as { tools?: { name: string }[] };
    return (result.tools ?? []).map((t) => t.name);
  }

  /** Yalnızca izin verilen araçlar; aracın cevabı (JSON ise nesne, değilse metin). */
  async callTool(name: AllowedTool, args: Record<string, unknown>): Promise<unknown> {
    if (!ALLOWED_TOOLS.includes(name)) throw new Error(`İzin verilmeyen araç: ${name}`);
    await this.ensureInitialized();
    const result = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    if (result.isError) throw new Error(`İade sistemi aracı hata verdi: ${textOf(result).slice(0, 200)}`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = textOf(result);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

const textOf = (r: { content?: { type: string; text?: string }[] }) =>
  (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

// ---------------------------------------------------------------------------
// Cevaptan yalnızca izin verilen alanlar alınır (izin listesi: bilinmeyen her alan atılır).

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function pick(o: Obj, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
}
const str = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

const CODE = ["kod", "talep_kodu", "code"];
const STATUS = ["durum", "status"];
const TYPE = ["tur", "type"];
const CREATED = ["olusturma_tarihi", "olusturulma", "tarih", "created_at", "createdAt"];
const ORDER = ["siparis_no", "siparis", "order_name", "order"];
const STORE = ["magaza", "store"];
const HISTORY = ["gecmis", "durum_gecmisi", "history", "hareketler"];
const ITEMS = ["urunler", "items"];
const SHIP_CODE = ["kargo_kodu", "iade_kargo_kodu"];
const CARRIER = ["kargo_firmasi"];

/** Cevabın içindeki talep nesneleri (kök dizi ya da "talepler"/"sonuclar" gibi bir alan). */
function requestObjects(value: unknown): Obj[] {
  if (Array.isArray(value)) return value.filter(isObj);
  if (!isObj(value)) return [];
  if (pick(value, STATUS) !== undefined && (pick(value, CODE) !== undefined || pick(value, ORDER) !== undefined)) return [value];
  for (const v of Object.values(value)) {
    if (Array.isArray(v) && v.some(isObj)) return v.filter(isObj);
    if (isObj(v)) {
      const inner = requestObjects(v);
      if (inner.length) return inner;
    }
  }
  return [];
}

export function sanitizeRequest(o: Obj): ReturnRequestInfo {
  const history = pick(o, HISTORY);
  const items = pick(o, ITEMS);
  return {
    code: str(pick(o, CODE)),
    type: str(pick(o, TYPE)),
    status: str(pick(o, STATUS)),
    createdAt: str(pick(o, CREATED)),
    history: Array.isArray(history)
      ? history.filter(isObj).map((h) => ({ status: str(pick(h, STATUS)), at: str(pick(h, CREATED)) }))
      : [],
    returnShippingCode: str(pick(o, SHIP_CODE)),
    carrier: str(pick(o, CARRIER)),
    items: Array.isArray(items)
      ? items.filter(isObj).map((i) => ({
          title: str(pick(i, ["baslik", "title", "urun"])),
          variant: str(pick(i, ["varyant", "variant"])),
          quantity: num(pick(i, ["adet", "quantity"])),
          action: str(pick(i, ["islem", "action"])),
        }))
      : [],
  };
}

const digits = (s: string) => s.match(/\d+/g)?.join("") ?? "";
const normalizeOrder = (s: string) => s.replace(/[#\s]/g, "").toUpperCase();

/**
 * Paneldeki sipariş numarası bizim siparişimiz mi? "#MO-1271" ile "MO-1271" aynı; panel yalnızca
 * numarayı tutuyorsa ("1271") numara aynı olmalı. Başka önek ("#BS-1271") başka mağazanın siparişidir.
 */
export function sameReturnOrder(panelOrder: string, orderName: string): boolean {
  const a = normalizeOrder(panelOrder);
  const b = normalizeOrder(orderName);
  if (a === b) return true;
  return /^\d+$/.test(a) && a === digits(b);
}

/**
 * Kolay İade için iade sağlayıcısı. Sipariş numarası ve mağaza ile aranır. Bir talep yalnızca hem
 * mağazası hem sipariş numarası kesin eşleşirse gösterilir; eksik alan "eşleşmiyor" sayılır (başka
 * müşterinin talebi asla gösterilmez). Talep ayrıntısı geldikten sonra aynı kontrol tekrarlanır.
 */
export function kolayIadeProvider(opts: { url: string; key: string; store: string; fetch?: Fetch }): ReturnsProvider {
  const client = new McpClient({ url: opts.url, key: opts.key, fetch: opts.fetch });
  const storeMatches = (o: Obj) => str(pick(o, STORE))?.toLowerCase() === opts.store.toLowerCase();
  return {
    async requestsFor(orderName) {
      const wanted = digits(orderName);
      if (!wanted) return [];
      const orderMatches = (o: Obj) => {
        const order = str(pick(o, ORDER));
        return order !== null && sameReturnOrder(order, orderName);
      };
      const search = async (sorgu: string) =>
        requestObjects(await client.callTool("talep_ara", { sorgu, magaza: opts.store, limit: 10 }));
      // Panel sipariş numarasını "#MO-1271" ya da "1271" diye tutuyor olabilir.
      let results = await search(orderName);
      if (!results.length) results = await search(wanted);
      // Arama satırında mağaza yazmıyorsa ayrıntıda aranır; başka mağaza yazıyorsa hemen elenir.
      const candidates = results.filter((o) => orderMatches(o) && (pick(o, STORE) === undefined || storeMatches(o)));
      const out: ReturnRequestInfo[] = [];
      for (const o of candidates.slice(0, 3)) {
        const code = str(pick(o, CODE));
        let detail: Obj = o;
        if (code) {
          const d = requestObjects(await client.callTool("talep_detay", { kod: code }))[0];
          if (d) detail = { ...o, ...d };
        }
        if (orderMatches(detail) && storeMatches(detail)) out.push(sanitizeRequest(detail));
      }
      return out;
    },
  };
}
