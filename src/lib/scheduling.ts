/**
 * Pure scheduling math shared by the availability engine, reservation
 * validation, the admin calendar, and tests. No Convex, no React, no I/O —
 * fully unit-testable.
 */
import { addMinutesToTime, dayOfWeek, MAX_PARTY_SIZE, MIN_PARTY_SIZE } from "./tz";

const MINUTE = 60_000;

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Opening hours entry for one weekday. Times are local wall clock "HH:MM". */
export interface HoursEntry {
  /** 0 = Sunday … 6 = Saturday. */
  day: number;
  /** "HH:MM" local open time; null when the restaurant is closed that day. */
  open: string | null;
  /** "HH:MM" local close time (exclusive); null when closed. May pass midnight. */
  close: string | null;
}

export interface OpeningHoursDoc {
  /** One entry per weekday (7 entries), stored on the restaurant document. */
  weekly: HoursEntry[];
}

export const DEFAULT_HOURS: OpeningHoursDoc = {
  weekly: Array.from({ length: 7 }, (_, day) => ({
    day,
    open: "11:00",
    close: "22:00",
  })),
};

export function isEntryOpen(e: HoursEntry | undefined): boolean {
  return !!e && e.open !== null && e.close !== null;
}

/**
 * Does a shift (local start → local end wall clock, possibly crossing
 * midnight) intersect a weekday's opening window?
 *
 * A shift that starts before closing but runs past midnight still overlaps
 * the open window (e.g. open 17:00–01:00, shift 23:00–03:00 overlaps).
 */
export function shiftIntersectsWindow(
  shiftStart: string,
  shiftEnd: string,
  entry: HoursEntry,
): boolean {
  if (!isEntryOpen(entry)) return false;
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const open = toMin(entry.open!);
  let close = toMin(entry.close!);
  if (close <= open) close += 24 * 60; // crosses midnight
  let start = toMin(shiftStart);
  let end = toMin(shiftEnd);
  if (end <= start) end += 24 * 60; // crosses midnight
  return start < close && end > open;
}

/**
 * Generate reservation slot start times ("HH:MM") for a given local date and
 * opening window. Slots start every `slotStepMinutes` starting at the open
 * time; the last slot starts early enough that the reservation ends by close.
 * Handles windows that cross midnight (close < open) by unwrapping into the
 * next day.
 */
export function generateSlotsForWindow(
  open: string,
  close: string,
  reservationDurationMin: number,
  slotStepMinutes: number,
): string[] {
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  let openM = toMin(open);
  let closeM = toMin(close);
  if (closeM <= openM) closeM += 24 * 60;
  const slots: string[] = [];
  for (let t = openM; t + reservationDurationMin <= closeM; t += slotStepMinutes) {
    const total = t % (24 * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return slots;
}

export interface SlotValidationInput {
  /** Local date "YYYY-MM-DD". */
  date: string;
  /** Local start "HH:MM". */
  time: string;
  /** Local end "HH:MM" (start + reservation duration). */
  endTime: string;
  hours: OpeningHoursDoc;
  partySize: number;
  minPartySize?: number;
  maxPartySize?: number;
  /** Epoch ms of "now" for past/window checks. */
  nowMs: number;
  /** IANA zone used to compare the requested local time against now. */
  timeZone: string;
  /** How close to now a reservation may start (minutes). */
  minLeadMinutes?: number;
  /** Max days ahead a reservation may be made. */
  maxAdvanceDays?: number;
}

export type SlotValidationCode =
  | "INVALID_PARTY_SIZE"
  | "PAST_RESERVATION"
  | "BOOKING_WINDOW"
  | "RESTAURANT_CLOSED"
  | "INVALID_DATE_TIME";

export interface SlotValidationResult {
  ok: boolean;
  code?: SlotValidationCode;
  message?: string;
}

/**
 * Validate a requested slot against restaurant rules — pure and synchronous.
 * Availability-vs-other-reservations is NOT checked here; the engine/tx does that.
 */
export function validateSlotAgainstHours(
  input: SlotValidationInput,
): SlotValidationResult {
  const {
    date,
    time,
    endTime,
    hours,
    partySize,
    minPartySize = MIN_PARTY_SIZE,
    maxPartySize = MAX_PARTY_SIZE,
    nowMs,
    timeZone,
    minLeadMinutes = 15,
    maxAdvanceDays = 60,
  } = input;

  const dow = dayOfWeek(date);
  if (dow === null) {
    return { ok: false, code: "INVALID_DATE_TIME", message: "Invalid date." };
  }
  if (!Number.isInteger(partySize) || partySize < minPartySize || partySize > maxPartySize) {
    return {
      ok: false,
      code: "INVALID_PARTY_SIZE",
      message: `Party size must be between ${minPartySize} and ${maxPartySize}.`,
    };
  }

  // Past check (restaurant-local): compare requested local wall clock against
  // local wall clock of `now` in the same zone.
  const nowLocal = nowWall(nowMs, timeZone);
  const requestLocal = `${date}T${time}`;
  const nowLocalStr = `${nowLocal.date}T${nowLocal.time}`;
  if (requestLocal <= nowLocalStr) {
    return {
      ok: false,
      code: "PAST_RESERVATION",
      message: "You can't book a table in the past.",
    };
  }

  // Advance-window check (calendar days, zone-agnostic count).
  const daysAhead = daysBetweenDates(nowLocal.date, date);
  if (daysAhead === null) {
    return { ok: false, code: "INVALID_DATE_TIME", message: "Invalid date." };
  }
  if (daysAhead > maxAdvanceDays) {
    return {
      ok: false,
      code: "BOOKING_WINDOW",
      message: `Reservations open up to ${maxAdvanceDays} days ahead.`,
    };
  }

  const entry = hours.weekly.find((h) => h.day === dow);
  if (!isEntryOpen(entry)) {
    return {
      ok: false,
      code: "RESTAURANT_CLOSED",
      message: "The restaurant is closed on that day.",
    };
  }

  // The reservation's local span [start,end) must intersect the open window.
  if (!shiftIntersectsWindow(time, endTime, entry as HoursEntry)) {
    return {
      ok: false,
      code: "RESTAURANT_CLOSED",
      message: "That time is outside opening hours.",
    };
  }

  // Minimum lead time (minutes) measured via UTC delta to respect DST.
  const leadMs = minLeadMinutes * MINUTE;
  if (nowMs + leadMs > requestUtcMs(date, time, timeZone)) {
    return {
      ok: false,
      code: "BOOKING_WINDOW",
      message: `Reservations need at least ${minLeadMinutes} minutes notice.`,
    };
  }

  return { ok: true };
}

/** Local wall clock of `nowMs` in a zone. */
function nowWall(nowMs: number, timeZone: string): { date: string; time: string } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(nowMs));
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const hour = map.hour === "24" ? "00" : map.hour;
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${hour}:${map.minute}` };
}

/** Local→UTC conversion using the tz lib (kept local to avoid cycles). */
function requestUtcMs(date: string, time: string, timeZone: string): number {
  return localToUtcMs(date, time, timeZone) ?? Number.NEGATIVE_INFINITY;
}

/**
 * Grid rows for the admin calendar: time rows × table columns. A cell is
 * "BOOKED" when any active reservation overlaps the row interval for that
 * table; "AVAILABLE" otherwise. Pure and unit-testable.
 */
export interface CalendarCell {
  tableId: string;
  rowStart: string;
  rowEnd: string;
  booked: boolean;
  reservationId?: string;
  reservationCode?: string;
  partySize?: number;
}

export interface CalendarGridInput {
  tables: { _id: string; tableNumber: number; capacity: number }[];
  /** Active reservations with local wall-clock start/end. */
  reservations: {
    _id: string;
    tableId: string;
    startLocal: string;
    endLocal: string;
    code?: string;
    partySize: number;
  }[];
  rowStart: string;
  rowEnd: string;
  rowStep: number;
}

export function buildCalendarGrid(input: CalendarGridInput): {
  times: string[];
  cells: CalendarCell[][];
} {
  const { tables, reservations, rowStart, rowEnd, rowStep } = input;
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const startM = toMin(rowStart);
  const endM = toMin(rowEnd);
  const times: string[] = [];
  for (let t = startM; t < endM; t += rowStep) {
    const total = t % (24 * 60);
    times.push(`${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`);
  }

  const byTable = new Map<string, typeof reservations>();
  for (const r of reservations) {
    const arr = byTable.get(r.tableId) ?? [];
    arr.push(r);
    byTable.set(r.tableId, arr);
  }

  const cells: CalendarCell[][] = times.map((rowStart) => {
    const rowStartM = toMin(rowStart);
    const rowEndM = rowStartM + rowStep;
    return tables.map((table) => {
      let cell: CalendarCell = {
        tableId: table._id,
        rowStart,
        rowEnd: addMinutesToTime(rowStart, rowStep) ?? rowStart,
        booked: false,
      };
      for (const r of byTable.get(table._id) ?? []) {
        const rs = toMin(r.startLocal);
        const re = toMin(r.endLocal) > rs ? toMin(r.endLocal) : toMin(r.endLocal) + 1440;
        if (rs < rowEndM && re > rowStartM) {
          cell = {
            tableId: table._id,
            rowStart,
            rowEnd: addMinutesToTime(rowStart, rowStep) ?? rowStart,
            booked: true,
            reservationId: r._id,
            reservationCode: r.code,
            partySize: r.partySize,
          };
          break;
        }
      }
      return cell;
    });
  });

  return { times, cells };
}

/** "18:00" + 30 → "18:30" row labels for calendar display. */
export function rowEndLabel(rowStart: string, step: number): string {
  return addMinutesToTime(rowStart, step) ?? rowStart;
}

export { MIN_PARTY_SIZE, MAX_PARTY_SIZE };
