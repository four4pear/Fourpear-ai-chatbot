import { expect, it, vi } from "vitest";
import { groqTranscriber, MAX_AUDIO_BYTES } from "../src/core/transcribe.js";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("sesi Groq'a çok parçalı istekle gönderir, metni döner", async () => {
  const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => ok({ text: "  Merhaba, siparişim nerede?  " }));
  const text = await groqTranscriber("gsk_test", "whisper-large-v3-turbo", fetchFn as unknown as typeof fetch)({ data: Buffer.from("ses"), mimeType: "audio/ogg; codecs=opus" });
  expect(text).toBe("Merhaba, siparişim nerede?");
  const [url, init] = fetchFn.mock.calls[0]!;
  expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gsk_test");
  const form = init.body as FormData;
  expect(form.get("model")).toBe("whisper-large-v3-turbo");
  expect((form.get("file") as File).name).toBe("ses.ogg");
});

it("boş, çok büyük ya da sessiz kayıtta null döner; servis hatasında hata fırlatır", async () => {
  const fetchFn = vi.fn(async () => ok({ text: "" }));
  const transcribe = groqTranscriber("k", "m", fetchFn as unknown as typeof fetch);
  expect(await transcribe({ data: Buffer.alloc(0), mimeType: "audio/ogg" })).toBeNull();
  expect(await transcribe({ data: Buffer.alloc(MAX_AUDIO_BYTES + 1), mimeType: "audio/ogg" })).toBeNull();
  expect(fetchFn).not.toHaveBeenCalled();
  expect(await transcribe({ data: Buffer.from("x"), mimeType: "audio/ogg" })).toBeNull();
  const failing = groqTranscriber("k", "m", (async () => ok({ error: "limit" }, 429)) as unknown as typeof fetch);
  await expect(failing({ data: Buffer.from("x"), mimeType: "audio/ogg" })).rejects.toThrow("HTTP 429");
});
