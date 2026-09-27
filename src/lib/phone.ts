/**
 * Telefon numarasını karşılaştırılabilir biçime getirir (sadece rakam, ülke koduyla).
 * WhatsApp numaraları (905321234567) ile Shopify'daki "+90 532 123 45 67",
 * "0532 123 4567" gibi yazımları eşleştirmek için kullanılır.
 */
export function normalizePhone(raw: string, defaultCountryCode = "90"): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = defaultCountryCode + digits.slice(1);
  else if (defaultCountryCode === "90" && digits.length === 10 && digits.startsWith("5")) digits = "90" + digits;
  return digits;
}

export function samePhone(a: string, b: string): boolean {
  const na = normalizePhone(a);
  return na.length >= 10 && na === normalizePhone(b);
}
