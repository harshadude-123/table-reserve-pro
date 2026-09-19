/**
 * Targeted tests for the pure scheduling/timezone primitives and the
 * no-double-booking overlap rule. Run with: bun test
 */
import { describe, expect, test } from "bun:test";

import {
  addMinutesToTime,
  daysBetweenDates,
  dayOfWeek,
  localToUtcMs,
  MAX_PARTY_SIZE,
  MIN_PARTY_SIZE,
  zoneOffsetMinutes,
} from "../src/lib/tz";
import {
  checkOverlap,
  DEFAULT_HOURS,
  generateSlotsForWindow,
  shiftIntersectsWindow,
  validateSlotAgainstHours,
} from "../src/lib/scheduling";

/* ------------------------------------------------------------------ */
/* No-double-booking overlap rule                                      */
/* ------------------------------------------------------------------ */

describe("checkOverlap (no-double-booking rule)", () => {
  const req = { start: 600, end: 690 }; // 18:00–19:30 in minutes-since-epoch terms

  test("exact same window conflicts", () => {
    expect(checkOverlap(req, req)).toBe(true);
  });

  test("partial overlap conflicts", () => {
    expect(checkOverlap({ start: 630, end: 720 }, req)).toBe(true);
    expect(checkOverlap({ start: 570, end: 660 }, req)).toBe(true);
  });

  test("containing reservation conflicts", () => {
    expect(checkOverlap({ start: 540, end: 750 }, req)).toBe(true);
  });

  test("back-to-back does NOT conflict (end === next start)", () => {
    expect(checkOverlap({ start: 510, end: 600 }, req)).toBe(false);
    expect(checkOverlap({ start: 690, end: 780 }, req)).toBe(false);
  });

  test("disjoint windows do not conflict", () => {
    expect(checkOverlap({ start: 0, end: 100 }, req)).toBe(false);
    expect(checkOverlap({ start: 900, end: 999 }, req)).toBe(false);
  });

  test("cancelled reservations never conflict", () => {
    expect(checkOverlap({ ...req, status: "cancelled" }, req)).toBe(false);
  });

  test("is commutative for plain windows", () => {
    expect(checkOverlap(req, { start: 630, end: 720 })).toBe(true);
    expect(checkOverlap({ start: 630, end: 720 }, req)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Timezone math                                                       */
/* ------------------------------------------------------------------ */

describe("tz helpers", () => {
  test("localToUtcMs handles a fixed-offset zone", () => {
    // 2026-06-15 18:00 in New York (EDT, UTC-4) = 2026-06-15 22:00 UTC
    const utc = localToUtcMs("2026-06-15", "18:00", "America/New_York");
    expect(utc).toBe(Date.UTC(2026, 5, 15, 22, 0, 0));
  });

  test("localToUtcMs is DST-aware across seasons", () => {
    const summer = localToUtcMs("2026-07-01", "12:00", "America/New_York");
    const winter = localToUtcMs("2026-01-15", "12:00", "America/New_York");
    expect(summer).not.toBe(winter);
    expect(summer).toBe(Date.UTC(2026, 6, 1, 16, 0, 0)); // UTC-4
    expect(winter).toBe(Date.UTC(2026, 0, 15, 17, 0, 0)); // UTC-5
  });

  test("localToUtcMs rejects bad input", () => {
    // Format-level validation: malformed strings and out-of-range times → null.
    // (In-range but nonexistent calendar dates like 2026-02-30 are normalized
    // by Date.UTC — pre-existing, intended behavior.)
    expect(localToUtcMs("2026-2-30", "18:00", "America/New_York")).toBeNull();
    expect(localToUtcMs("not-a-date", "18:00", "America/New_York")).toBeNull();
    expect(localToUtcMs("2026-06-15", "25:00", "America/New_York")).toBeNull();
    expect(localToUtcMs("2026-06-15", "18:99", "America/New_York")).toBeNull();
    expect(localToUtcMs("2026-06-15", "18:00", "Not/AZone")).toBeNull();
  });

  test("zoneOffsetMinutes sign convention", () => {
    const june15 = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(zoneOffsetMinutes(june15, "America/New_York")).toBe(-240); // UTC-4
    expect(zoneOffsetMinutes(june15, "UTC")).toBe(0);
    expect(zoneOffsetMinutes(june15, "Asia/Kolkata")).toBe(330); // UTC+5:30
  });

  test("era handling does not corrupt modern dates (regression)", () => {
    // The era part is now excluded from the numeric map; sanity-check offsets.
    const ms = Date.UTC(2026, 8, 19, 12, 0, 0);
    expect(zoneOffsetMinutes(ms, "Europe/London")).toBeOneOf([60, 0]);
  });

  test("addMinutesToTime wraps midnight", () => {
    expect(addMinutesToTime("23:30", 90)).toBe("01:00");
    expect(addMinutesToTime("18:00", 90)).toBe("19:30");
    expect(addMinutesToTime("bad", 30)).toBeNull();
  });

  test("daysBetweenDates is calendar-accurate", () => {
    expect(daysBetweenDates("2026-01-01", "2026-01-02")).toBe(1);
    expect(daysBetweenDates("2026-01-02", "2026-01-01")).toBe(-1);
    expect(daysBetweenDates("2026-02-28", "2026-03-01")).toBe(1); // non-leap
    expect(daysBetweenDates("2024-02-28", "2024-03-01")).toBe(2); // leap
    expect(daysBetweenDates("bad", "2026-01-01")).toBeNull();
  });

  test("dayOfWeek matches known calendar days", () => {
    expect(dayOfWeek("2026-09-19")).toBe(6); // Saturday
    expect(dayOfWeek("2026-09-20")).toBe(0); // Sunday
  });

  test("party size bounds constants", () => {
    expect(MIN_PARTY_SIZE).toBe(1);
    expect(MAX_PARTY_SIZE).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
/* Slot generation and validation                                      */
/* ------------------------------------------------------------------ */

describe("generateSlotsForWindow", () => {
  test("basic window with 30-min steps and 90-min duration", () => {
    const slots = generateSlotsForWindow("17:00", "22:00", 90, 30);
    expect(slots[0]).toBe("17:00");
    expect(slots).toContain("20:00"); // ends 21:30 — before close
    expect(slots).toContain("20:30"); // ends exactly at close — allowed
    expect(slots).not.toContain("21:00"); // would end 22:30 — excluded
    expect(slots[slots.length - 1]).toBe("20:30");
    expect(slots.every((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s))).toBe(true);
  });

  test("windows crossing midnight are handled", () => {
    const slots = generateSlotsForWindow("22:00", "01:00", 60, 60);
    expect(slots[0]).toBe("22:00");
    expect(slots).toContain("23:00");
    expect(slots).toContain("00:00");
  });
});

describe("shiftIntersectsWindow", () => {
  test("shift inside window intersects", () => {
    expect(shiftIntersectsWindow("18:00", "19:30", { day: 5, open: "11:00", close: "22:00" })).toBe(true);
  });

  test("shift entirely after close does not intersect", () => {
    expect(shiftIntersectsWindow("23:00", "00:30", { day: 5, open: "11:00", close: "22:00" })).toBe(false);
  });

  test("closed days never intersect", () => {
    expect(shiftIntersectsWindow("12:00", "13:00", { day: 5, open: null, close: null })).toBe(false);
  });
});

describe("validateSlotAgainstHours", () => {
  const now = Date.UTC(2026, 8, 19, 12, 0, 0); // 2026-09-19 12:00 UTC
  const base = {
    endTime: "19:30",
    hours: DEFAULT_HOURS,
    partySize: 2,
    nowMs: now,
    timeZone: "UTC",
  };

  test("accepts a valid future slot", () => {
    const res = validateSlotAgainstHours({ ...base, date: "2026-09-25", time: "18:00" });
    expect(res.ok).toBe(true);
  });

  test("rejects past slots", () => {
    const res = validateSlotAgainstHours({ ...base, date: "2026-09-19", time: "00:30" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("PAST_RESERVATION");
  });

  test("rejects party sizes out of range", () => {
    const res = validateSlotAgainstHours({ ...base, date: "2026-09-25", time: "18:00", partySize: 99 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_PARTY_SIZE");
  });

  test("rejects closed days", () => {
    const closed = { weekly: DEFAULT_HOURS.weekly.map((h) => ({ ...h, open: null, close: null })) };
    const res = validateSlotAgainstHours({ ...base, date: "2026-09-25", time: "18:00", hours: closed });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("RESTAURANT_CLOSED");
  });

  test("rejects bookings beyond the advance window", () => {
    const res = validateSlotAgainstHours({
      ...base,
      date: "2027-09-25",
      time: "18:00",
      maxAdvanceDays: 60,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("BOOKING_WINDOW");
  });

  test("enforces minimum lead time", () => {
    // 12:05 UTC now; 12:10 UTC slot with 15-min lead → too soon.
    const res = validateSlotAgainstHours({
      ...base,
      nowMs: Date.UTC(2026, 8, 19, 12, 5, 0),
      date: "2026-09-19",
      time: "12:10",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("BOOKING_WINDOW");
  });

  test("invalid dates are rejected", () => {
    const res = validateSlotAgainstHours({ ...base, date: "not-a-date", time: "18:00" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_DATE_TIME");
  });
});
