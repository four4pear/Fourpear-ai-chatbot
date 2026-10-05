/**
 * Sesli mesajı yazıya çevirir (docs/lina-davranis.md "Sesli mesajlar"). Claude sesi okuyamaz; ayrı bir
 * konuşma-yazı servisi kullanılır. Ses kaydı saklanmaz: çevrildikten sonra atılır, yalnızca metin kalır.
 */
export type Transcriber = (audio: { data: Buffer; mimeType: string }) => Promise<string | null>;

/** Bundan büyük kayıt çevrilmez (WhatsApp sesli mesajı genelde birkaç yüz KB'dir). */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/** Groq üzerinden Whisper: hızlı ve çok ucuz (küçük kullanımda ücretsiz katman). Dili kendisi algılar. */
export function groqTranscriber(apiKey: string, model = "whisper-large-v3-turbo", fetchFn: typeof fetch = fetch): Transcriber {
  return async ({ data, mimeType }) => {
    if (data.length === 0 || data.length > MAX_AUDIO_BYTES) return null;
    const form = new FormData();
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") || mimeType.includes("aac") ? "m4a" : mimeType.includes("mpeg") ? "mp3" : "ogg";
    form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), `ses.${ext}`);
    form.append("model", model);
    form.append("response_format", "json");
    form.append("temperature", "0");
    const res = await fetchFn(GROQ_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Ses çevirisi başarısız (HTTP ${res.status})`);
    const body = (await res.json()) as { text?: string };
    const text = body.text?.trim();
    return text ? text : null;
  };
}
