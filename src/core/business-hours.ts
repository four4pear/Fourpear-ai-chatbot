import type { BusinessHours } from "../db/schema.js";

const DAY_NAMES = ["pazar", "pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi"];

export type BusinessStatus =
  | { open: true }
  /** nextOpening: müşteriye söylenecek ifade, ör. "yarın saat 10:00" */
  | { open: false; nextOpening: string | null };

function localParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { weekday, minutes: +parts.hour! * 60 + +parts.minute! };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + (m ?? 0);
};

/** Mağaza şu an açık mı; kapalıysa bir sonraki açılışın müşteriye söylenecek hâli. */
export function businessStatus(hours: BusinessHours, timeZone: string, now = new Date()): BusinessStatus {
  const { weekday, minutes } = localParts(now, timeZone);
  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
  const isOpenDay = (d: number) => hours.days.includes(d);

  if (isOpenDay(weekday) && minutes >= start && minutes < end) return { open: true };

  // Bugün henüz açılmadıysa bugün; değilse sonraki açık gün.
  for (let offset = 0; offset <= 7; offset++) {
    const day = (weekday + offset) % 7;
    if (!isOpenDay(day)) continue;
    if (offset === 0 && minutes >= start) continue;
    const when = offset === 0 ? "bugün" : offset === 1 ? "yarın" : DAY_NAMES[day]!;
    return { open: false, nextOpening: `${when} saat ${hours.start}` };
  }
  return { open: false, nextOpening: null };
}
