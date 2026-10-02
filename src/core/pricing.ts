/**
 * Anthropic fiyatları, 1 milyon token başına dolar (Eylül 2026). Önbellek: okuma girdinin 0,1 katı,
 * 5 dakikalık yazma 1,25 katı. Tahmini maliyet içindir; kesin tutar Anthropic faturasındadır.
 */
const PRICES: { prefix: string; input: number; output: number }[] = [
  { prefix: "claude-sonnet-5", input: 2, output: 10 }, // Sonnet 5 ve 5.5
  { prefix: "claude-haiku-4-5", input: 1, output: 5 },
  { prefix: "claude-opus-5-5", input: 4, output: 20 },
  { prefix: "claude-opus-5", input: 5, output: 25 },
];
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;

export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/** Bilinmeyen modelde null (tabloda "—"). */
export function costUsd(model: string, u: TokenUsage): number | null {
  const price = PRICES.find((p) => model.startsWith(p.prefix));
  if (!price) return null;
  const input = u.inputTokens + u.cacheReadTokens * CACHE_READ + u.cacheWriteTokens * CACHE_WRITE_5M;
  return (input * price.input + u.outputTokens * price.output) / 1_000_000;
}
