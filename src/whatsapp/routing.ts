import type { WhatsAppSender } from "./client.js";
import { isZernioAccount } from "./zernio.js";

/**
 * Hat hangi yolla bağlıysa o yoldan konuşur: "zernio:" ile başlayan hatlar Zernio'dan, diğerleri
 * doğrudan Meta'dan. Medya kimliği http ile başlıyorsa bir adrestir (Zernio), değilse Meta medya kimliği.
 */
export function createRoutingSender(meta: WhatsAppSender, zernio: WhatsAppSender): WhatsAppSender {
  const pick = (phoneNumberId: string) => (isZernioAccount(phoneNumberId) ? zernio : meta);
  return {
    sendText: (opts) => pick(opts.phoneNumberId).sendText(opts),
    markReadAndTyping: (opts) => pick(opts.phoneNumberId).markReadAndTyping(opts),
    downloadMedia: (opts) => (/^https?:\/\//i.test(opts.mediaId) ? zernio : meta).downloadMedia(opts),
  };
}
