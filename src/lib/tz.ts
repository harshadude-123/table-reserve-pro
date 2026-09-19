/**
 * Timezone-aware time math for TableKeeper.
 *
 * All reservation timestamps in the database are UTC milliseconds. Selected
 * times arrive from the UI as restaurant-local wall-clock fields
 * (YYYY-MM-DD + HH:MM) that must be interpreted in the restaurant's IANA
 * timezone and converted to UTC. No fixed offsets, ever — we use
 * Intl.DateTimeFormat against real IANA zones, which is what makes DST
 * transitions behave correctly.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const MIN_PARTY_SIZE = 1;
export const MAX_PARTY_SIZE = 20;

/** IANA zones we ship demo data for. The UI offers these + the browser zone. */
export const DEMO_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

/**
 * Offsets of an IANA zone from UTC at a given instant, in minutes.
 * Positive = ahead of UTC (e.g. America/New_York in summer → -240? no:
 * New York is UTC-4 in summer, so this returns -240).
 */
export function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    era: "short",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  let era = "";
  for (const part of parts) {
    if (part.type === "era") {
      era = part.value;
      continue;
    }
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  // `era: short` + hour12:false: hour "24" normalization for midnight in some
  // runtimes — treat hour 24 as 0. BC/AD handled via year sign below.
  let year = map.year as number;
  if (era === "BC" || era === "B") year = 1 - year;
  const hour = map.hour === 24 ? 0 : (map.hour as number);
  const asUTC = Date.UTC(
    year,
    (map.month as number) - 1,
    map.day as number,
    hour,
    map.minute as number,
    map.second as number,
  );
  return Math.round((asUTC - utcMs) / MINUTE);
}

/** Validate a zone is a real IANA identifier (e.g. rejects "UTC+5"). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface LocalWallClock {
  /** YYYY-MM-DD in the restaurant's local calendar. */
  date: string;
  /** HH:MM 24h local wall clock. */
  time: string;
}

function parseDatePart(date: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function parseTimePart(time: string): { h: number; min: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

/**
 * Convert restaurant-local wall clock → UTC ms. Ambiguous local times (DST
 * fall-back) resolve to the earlier instant; nonexistent times (spring-forward
 * gap) resolve to the instant after the gap — matching how reservation
 * systems typically normalize edge cases.
 */
export function localToUtcMs(
  date: string,
  time: string,
  timeZone: string,
): number | null {
  if (!isValidTimeZone(timeZone)) return null;
  const dp = parseDatePart(date);
  const tp = parseTimePart(time);
  if (!dp || !tp) return null;
  const { y, m, d } = dp;
  const { h, min } = tp;

  // First guess: treat wall clock as if it were UTC.
  const naive = Date.UTC(y, m - 1, d, h, min, 0);
  let offset = zoneOffsetMinutes(naive, timeZone);
  let candidate = naive - offset * MINUTE;
  // Refine once — handles instants where the offset itself changes.
  const offset2 = zoneOffsetMinutes(candidate, timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    candidate = naive - offset * MINUTE;
  }
  return candidate;
}

/** UTC ms → local wall clock in the given zone. */
export function utcMsToLocal(
  utcMs: number,
  timeZone: string,
): LocalWallClock {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const hour = map.hour === "24" ? "00" : map.hour;
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${hour}:${map.minute}`,
  };
}

/** "19:30" + 90 → "21:00" (handles midnight wrap). Returns null if invalid. */
export function addMinutesToTime(time: string, minutes: number): string | null {
  const tp = parseTimePart(time);
  if (!tp) return null;
  const total = (tp.h * 60 + tp.min + minutes) % (24 * 60);
  const h = Math.floor(total / 60);
  const min = total % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Today's local date (YYYY-MM-DD) in the given zone, relative to `nowMs`. */
export function todayInZone(nowMs: number, timeZone: string): string {
  return utcMsToLocal(nowMs, timeZone).date;
}

/** Add days to a YYYY-MM-DD date (calendar-accurate, no DST shortcuts). */
export function addDaysToDate(date: string, days: number): string | null {
  const dp = parseDatePart(date);
  if (!dp) return null;
  const dt = new Date(Date.UTC(dp.y, dp.m - 1, dp.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Day of week (0=Sunday) for a YYYY-MM-DD local calendar date. */
export function dayOfWeek(date: string): number | null {
  const dp = parseDatePart(date);
  if (!dp) return null;
  return new Date(Date.UTC(dp.y, dp.m - 1, dp.d)).getUTCDay();
}

/** Difference in whole calendar days b−a (both YYYY-MM-DD). */
export function daysBetweenDates(a: string, b: string): number | null {
  const pa = parseDatePart(a);
  const pb = parseDatePart(b);
  if (!pa || !pb) return null;
  const ua = Date.UTC(pa.y, pa.m - 1, pa.d);
  const ub = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((ub - ua) / DAY);
}

/** Pretty display: "Fri, Mar 14, 2026" in the given zone. */
export function formatDateInZone(
  utcMs: number,
  timeZone: string,
  locale = "en-US",
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(utcMs));
}

/** Pretty display: "7:00 PM" in the given zone. */
export function formatTimeInZone(
  utcMs: number,
  timeZone: string,
  locale = "en-US",
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(utcMs));
}

/** Short zone label like "EDT" / "GMT+5:30". */
export function zoneAbbreviation(utcMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(new Date(utcMs));
  return (
    parts.find((p) => p.type === "timeZoneName")?.value ??
    timeZone.split("/").pop() ??
    timeZone
  );
}

/** 12h label for a "HH:MM" wall time: "7:00 PM". */
export function formatWallTime(time: string): string {
  const tp = parseTimePart(time);
  if (!tp) return time;
  const h24 = tp.h;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(tp.min).padStart(2, "0")} ${ampm}`;
}

/**
 * Human description of a UTC instant in the restaurant zone plus the viewer's
 * own zone, e.g. "7:00 PM (EDT) — 4:00 PM your time". Used on confirmations.
 */
export function describeInBothZones(
  utcMs: number,
  restaurantZone: string,
  viewerZone: string,
): string {
  const local = `${formatTimeInZone(utcMs, restaurantZone)} ${zoneAbbreviation(utcMs, restaurantZone)}`;
  if (viewerZone === restaurantZone) return local;
  return `${local} · ${formatTimeInZone(utcMs, viewerZone)} your time`;
}

/** The browser's IANA zone, with a safe fallback. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
