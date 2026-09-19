/**
 * ReservationService — the heart of TableKeeper.
 *
 * CONCURRENCY MODEL
 * =================
 * Convex is serializable-by-construction: every mutation runs as a
 * serializable transaction with optimistic concurrency control (OCC) over
 * every document it reads. That gives us exactly the guarantee the product
 * needs:
 *
 *   1. reserveAtomic() READS all reservations for the candidate tables (its
 *      read set) and verifies no active reservation overlaps the requested
 *      window.
 *   2. It INSERTs the new reservation.
 *   3. At commit, Convex validates the read set against committed state. If a
 *      concurrent transaction committed any of those documents in the
 *      meantime (e.g. another overlapping reservation), this transaction is
 *      REJECTED and retried — the overlap check then re-runs against the
 *      newest data and fails cleanly with TABLE_CONFLICT / NO_AVAILABILITY.
 *
 * Two racing reservations therefore cannot both commit: the overlap check and
 * the insert are one atomic, serializable unit. This is the equivalent of
 * PostgreSQL SERIALIZABLE + an exclusion constraint, enforced by the database
 * engine rather than application JS.
 *
 * IDEMPOTENCY
 * ===========
 * Reserve requests carry a client-generated idempotency key. Keys live in an
 * `idempotency_keys` ledger whose row commits atomically with the
 * reservation it created. A duplicate request reads the ledger inside its own
 * transaction and, if the key exists, replays the original result instead of
 * booking again. Racing duplicates collide on the unique-key write at commit,
 * get retried by OCC, and then take the replay path. Double-clicks and
 * network retries can never create two reservations.
 */

import { v } from "convex/values";
import { mutation, internalMutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { encodeReservationError, ReservationErrorCode, reservationError } from "../lib/errors";
import { resolveUserId } from "./firebaseIdentity";
import {
  localToUtcMs,
  addMinutesToTime,
  utcMsToLocal,
  isValidTimeZone,
  MAX_PARTY_SIZE,
  MIN_PARTY_SIZE,
} from "../lib/tz";
import {
  DEFAULT_HOURS,
  generateSlotsForWindow,
  validateSlotAgainstHours,
  type OpeningHoursDoc,
} from "../lib/scheduling";
import { todayInZone } from "../lib/tz";

const MINUTE = 60_000;

export type ReservationStatus = "confirmed" | "cancelled" | "completed";

/** Result shape of an atomic reserve call (public or internal entrypoint). */
export interface ReserveResult {
  reservationId: string;
  code: string;
  status: ReservationStatus;
  tableId: string;
  tableNumber: number;
  startUtc: number;
  endUtc: number;
  partySize: number;
  restaurantTimezone: string;
  date: string;
  time: string;
  idempotencyKey?: string;
  idempotentReplay: boolean;
  auditId?: string;
}

/** Pure overlap rule, re-exported from the pure scheduling lib. */
export { checkOverlap } from "../lib/scheduling";

/**
 * Fire-and-forget mirror of a committed reservation event to Firebase
 * Realtime Database (see firebaseRtdb.ts). Scheduled after the mutation
 * commits, so it can never affect the transactional booking outcome. The
 * mirror persists the full reservation document (upsert) plus the activity
 * feed entry, giving RTDB a durable, realtime copy of every booking.
 */
export function scheduleMirror(
  ctx: MutationCtx,
  event: {
    restaurantId: Id<"restaurants">;
    reservationId: Id<"reservations"> | null;
    customerFirebaseUid?: string | null;
    code: string | null;
    result: string;
    tableNumber: number | null;
    partySize: number | null;
    localDate: string | null;
    localTime: string | null;
    localEndTime?: string | null;
    startUtc: number | null;
    endUtc: number | null;
    status?: string;
    requestId: string | null;
  },
): void {
  void (async () => {
    const restaurant = await ctx.db.get(event.restaurantId);
    await ctx.scheduler.runAfter(0, internal.firebaseRtdb.mirrorReservationEvent, {
      restaurantId: event.restaurantId,
      restaurantName: restaurant?.name ?? undefined,
      reservationId: event.reservationId,
      customerFirebaseUid: event.customerFirebaseUid ?? null,
      code: event.code,
      result: event.result,
      tableNumber: event.tableNumber ?? 0,
      partySize: event.partySize ?? 0,
      localDate: event.localDate ?? "",
      localTime: event.localTime ?? "",
      localEndTime: event.localEndTime ?? undefined,
      startUtc: event.startUtc ?? 0,
      endUtc: event.endUtc ?? 0,
      status: event.status,
      requestId: event.requestId,
    });
  })().catch((e) => console.error("[firebase-rtdb] scheduling failed:", e));
}

/** Human-friendly confirmation code: TK-<7 unambiguous base32 chars>. */
export function reservationCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
  let s = "";
  const bytes = new Uint8Array(7);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `TK-${s}`;
}

function fail(
  code: ReservationErrorCode,
  message: string,
  httpStatus = 400,
): never {
  throw encodeReservationError(reservationError(code, message, httpStatus));
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

async function requireUser(ctx: MutationCtx | QueryCtx): Promise<Id<"users">> {
  const userId = await resolveUserId(ctx);
  if (userId === null) fail(ReservationErrorCode.UNAUTHENTICATED, "Sign in to continue.", 401);
  return userId;
}

function assertHours(hours: unknown): OpeningHoursDoc {
  if (
    hours &&
    typeof hours === "object" &&
    Array.isArray((hours as OpeningHoursDoc).weekly) &&
    (hours as OpeningHoursDoc).weekly.length === 7
  ) {
    return hours as OpeningHoursDoc;
  }
  return DEFAULT_HOURS;
}

/** Convert a local slot to UTC bounds, throwing typed errors on bad input. */
function slotBounds(
  date: string,
  time: string,
  durationMin: number,
  timeZone: string,
): { startUtc: number; endUtc: number; endTime: string } {
  if (!isValidTimeZone(timeZone)) {
    fail(ReservationErrorCode.INVALID_DATE_TIME, "Restaurant has an invalid timezone configured.", 500);
  }
  const startUtc = localToUtcMs(date, time, timeZone);
  if (startUtc === null) {
    fail(ReservationErrorCode.INVALID_DATE_TIME, "That date or time isn't valid.", 400);
  }
  const endTime = addMinutesToTime(time, durationMin) ?? "23:59";
  // Duration is fixed wall-clock minutes; end instant = start + duration.
  const endUtc = startUtc + durationMin * MINUTE;
  return { startUtc, endUtc, endTime };
}

/** All tables of a restaurant, sorted by table number. */
async function tablesOfRestaurant(ctx: MutationCtx | QueryCtx, restaurantId: Id<"restaurants">) {
  const tables = await ctx.db
    .query("restaurant_tables")
    .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId))
    .collect();
  tables.sort((a, b) => a.tableNumber - b.tableNumber);
  return tables;
}

/* ------------------------------------------------------------------ */
/* Availability engine (informational; reserve always re-checks)       */
/* ------------------------------------------------------------------ */

export interface PartySlot {
  /** "HH:MM" local slot start. */
  time: string;
  /** Number of distinct tables free for this slot right now. */
  availableTables: number;
  available: boolean;
}

export interface DayAvailability {
  date: string;
  timeZone: string;
  slots: PartySlot[];
}

export const getDayAvailability = query({
  args: {
    restaurantId: v.id("restaurants"),
    date: v.string(), // local YYYY-MM-DD
    partySize: v.number(),
  },
  handler: async (ctx, { restaurantId, date, partySize }): Promise<DayAvailability> => {
    const restaurant = await ctx.db.get(restaurantId);
    if (!restaurant) fail(ReservationErrorCode.NOT_FOUND, "Restaurant not found.", 404);
    const hours = assertHours(restaurant.openingHours);
    const duration = restaurant.reservationDurationMin ?? 90;
    const step = restaurant.slotStepMin ?? 30;
    const nowMs = Date.now();

    if (!Number.isInteger(partySize) || partySize < MIN_PARTY_SIZE || partySize > MAX_PARTY_SIZE) {
      fail(
        ReservationErrorCode.INVALID_PARTY_SIZE,
        `Party size must be between ${MIN_PARTY_SIZE} and ${MAX_PARTY_SIZE}.`,
        400,
      );
    }

    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const entry = hours.weekly.find((h) => h.day === dow);
    const slotsForDay =
      entry && entry.open && entry.close
        ? generateSlotsForWindow(entry.open, entry.close, duration, step)
        : [];

    const tables = (await tablesOfRestaurant(ctx, restaurantId)).filter(
      (t) => t.status !== "out_of_service" && t.capacity >= partySize,
    );

    const dayRes = await ctx.db
      .query("reservations")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId))
      .collect();
    const active = dayRes.filter((r) => r.status !== "cancelled");

    const nowLocal = utcMsToLocal(nowMs, restaurant.timezone);
    const isToday = nowLocal.date === date;

    const slots: PartySlot[] = slotsForDay.map((time) => {
      const startUtc = localToUtcMs(date, time, restaurant.timezone);
      if (startUtc === null) return { time, availableTables: 0, available: false };
      const endUtc = startUtc + duration * MINUTE;

      // Today's past slots (with minimum lead) are not bookable.
      if (isToday && startUtc < nowMs + 15 * MINUTE) {
        return { time, availableTables: 0, available: false };
      }

      let free = 0;
      for (const t of tables) {
        const conflict = active.some(
          (r) => r.tableId === t._id && r.startTimeUtc < endUtc && r.endTimeUtc > startUtc,
        );
        if (!conflict) free += 1;
      }
      return { time, availableTables: free, available: free > 0 };
    });

    return { date, timeZone: restaurant.timezone, slots };
  },
});

/** Per-table availability for one exact slot (used by admin + tests). */
export const getInstantAvailability = query({
  args: {
    restaurantId: v.id("restaurants"),
    date: v.string(),
    time: v.string(),
    partySize: v.number(),
  },
  handler: async (ctx, { restaurantId, date, time, partySize }) => {
    const restaurant = await ctx.db.get(restaurantId);
    if (!restaurant) fail(ReservationErrorCode.NOT_FOUND, "Restaurant not found.", 404);
    const duration = restaurant.reservationDurationMin ?? 90;
    const startUtc = localToUtcMs(date, time, restaurant.timezone);
    if (startUtc === null) fail(ReservationErrorCode.INVALID_DATE_TIME, "Invalid date or time.", 400);
    const endUtc = startUtc + duration * MINUTE;

    const tables = await tablesOfRestaurant(ctx, restaurantId);
    const dayRes = await ctx.db
      .query("reservations")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId))
      .collect();
    const active = dayRes.filter((r) => r.status !== "cancelled");

    return tables.map((t) => {
      const conflict = active.find(
        (r) => r.tableId === t._id && r.startTimeUtc < endUtc && r.endTimeUtc > startUtc,
      );
      return {
        tableId: t._id,
        tableNumber: t.tableNumber,
        capacity: t.capacity,
        available: t.status !== "out_of_service" && !conflict && t.capacity >= partySize,
        reservationId: conflict?._id ?? null,
      };
    });
  },
});

/* ------------------------------------------------------------------ */
/* Reserve — atomic + idempotent                                       */
/* ------------------------------------------------------------------ */

/**
 * Atomic reservation:
 *  1. auth + restaurant + party-size + hours/lead validation (typed errors)
 *  2. idempotency replay check (same serializable tx)
 *  3. read candidate tables + their reservations (read set)
 *  4. overlap check → best-fit table selection
 *  5. insert reservation + idempotency ledger row (atomically)
 *  6. commit — OCC rejects racing conflicting writes; retries re-check.
 */
export const reserveAtomic = mutation({
  args: {
    restaurantId: v.id("restaurants"),
    date: v.string(),
    time: v.string(),
    partySize: v.number(),
    idempotencyKey: v.optional(v.string()),
    /** Optional explicit table (admin booking). Otherwise best-fit chosen. */
    tableId: v.optional(v.id("restaurant_tables")),
  },
  handler: async (ctx, input): Promise<{
    reservationId: string;
    code: string;
    status: ReservationStatus;
    tableId: string;
    tableNumber: number;
    startUtc: number;
    endUtc: number;
    partySize: number;
    restaurantTimezone: string;
    date: string;
    time: string;
    idempotencyKey?: string;
    idempotentReplay: boolean;
    auditId: string;
  }> => {
    const userId = await requireUser(ctx);
    const nowMs = Date.now();

    const restaurant = await ctx.db.get(input.restaurantId);
    if (!restaurant) fail(ReservationErrorCode.NOT_FOUND, "Restaurant not found.", 404);
    const hours = assertHours(restaurant.openingHours);
    const duration = restaurant.reservationDurationMin ?? 90;
    const tz = restaurant.timezone;

    // ---- Validation (pure rules; typed errors) ----
    const bounds = slotBounds(input.date, input.time, duration, tz);
    const vres = validateSlotAgainstHours({
      date: input.date,
      time: input.time,
      endTime: bounds.endTime,
      hours,
      partySize: input.partySize,
      nowMs,
      timeZone: tz,
      minLeadMinutes: restaurant.minLeadMinutes ?? 15,
      maxAdvanceDays: restaurant.maxAdvanceDays ?? 60,
    });
    if (!vres.ok) {
      const code = (vres.code ?? "VALIDATION") as ReservationErrorCode;
      fail(code, vres.message ?? "Invalid reservation request.", code === "RESTAURANT_CLOSED" ? 409 : 400);
    }

    // ---- Idempotency replay (same serializable tx) ----
    if (input.idempotencyKey) {
      const existing = await ctx.db
        .query("idempotency_keys")
        .withIndex("by_key", (q) => q.eq("key", input.idempotencyKey!))
        .unique();
      if (existing) {
        const res = await ctx.db.get(existing.reservationId);
        if (res) {
          const table = await ctx.db.get(res.tableId);
          const auditId = await logAudit(ctx, {
            restaurantId: restaurant._id,
            tableId: res.tableId,
            userId,
            requestedStart: res.startTimeUtc,
            requestedEnd: res.endTimeUtc,
            result: "idempotent_replay",
            failureReason: null,
            requestId: input.idempotencyKey,
          });
          return {
            reservationId: res._id,
            code: res.code,
            status: res.status as ReservationStatus,
            tableId: res.tableId,
            tableNumber: table?.tableNumber ?? 0,
            startUtc: res.startTimeUtc,
            endUtc: res.endTimeUtc,
            partySize: res.partySize,
            restaurantTimezone: tz,
            date: res.localDate,
            time: res.localTime,
            idempotencyKey: input.idempotencyKey,
            idempotentReplay: true,
            auditId,
          };
        }
      }
    }

    return await doReserve(ctx, input, restaurant, hours, duration, bounds, userId, nowMs);
  },
});

/**
 * Internal reserve entrypoint used by the REST surface, which resolves the
 * caller's identity at the HTTP boundary (httpActions cannot forward auth
 * into mutations) and passes the verified userId explicitly.
 */
export const reserveInternal = internalMutation({
  args: {
    userId: v.id("users"),
    restaurantId: v.id("restaurants"),
    date: v.string(),
    time: v.string(),
    partySize: v.number(),
    idempotencyKey: v.optional(v.string()),
    tableId: v.optional(v.id("restaurant_tables")),
  },
  handler: async (ctx, input): Promise<ReserveResult> => {
    const nowMs = Date.now();
    const restaurant = await ctx.db.get(input.restaurantId);
    if (!restaurant) fail(ReservationErrorCode.NOT_FOUND, "Restaurant not found.", 404);
    const hours = assertHours(restaurant.openingHours);
    const duration = restaurant.reservationDurationMin ?? 90;
    const bounds = slotBounds(input.date, input.time, duration, restaurant.timezone);
    const vres = validateSlotAgainstHours({
      date: input.date,
      time: input.time,
      endTime: bounds.endTime,
      hours,
      partySize: input.partySize,
      nowMs,
      timeZone: restaurant.timezone,
      minLeadMinutes: restaurant.minLeadMinutes ?? 15,
      maxAdvanceDays: restaurant.maxAdvanceDays ?? 60,
    });
    if (!vres.ok) {
      const code = (vres.code ?? "VALIDATION") as ReservationErrorCode;
      fail(code, vres.message ?? "Invalid reservation request.", code === "RESTAURANT_CLOSED" ? 409 : 400);
    }
    if (input.idempotencyKey) {
      const existing = await ctx.db
        .query("idempotency_keys")
        .withIndex("by_key", (q) => q.eq("key", input.idempotencyKey!))
        .unique();
      if (existing) {
        const res = await ctx.db.get(existing.reservationId);
        if (res) {
          const table = await ctx.db.get(res.tableId);
          return {
            reservationId: res._id,
            code: res.code,
            status: res.status as ReservationStatus,
            tableId: res.tableId,
            tableNumber: table?.tableNumber ?? 0,
            startUtc: res.startTimeUtc,
            endUtc: res.endTimeUtc,
            partySize: res.partySize,
            restaurantTimezone: restaurant.timezone,
            date: res.localDate,
            time: res.localTime,
            idempotencyKey: input.idempotencyKey,
            idempotentReplay: true,
          };
        }
      }
    }
    const out = await doReserve(ctx, input, restaurant, hours, duration, bounds, input.userId, nowMs);
    return out;
  },
});

async function doReserve(
  ctx: MutationCtx,
  input: {
    restaurantId: Id<"restaurants">;
    date: string;
    time: string;
    partySize: number;
    tableId?: Id<"restaurant_tables">;
    idempotencyKey?: string;
  },
  restaurant: { _id: Id<"restaurants">; timezone: string },
  _hours: OpeningHoursDoc,
  duration: number,
  bounds: { startUtc: number; endUtc: number; endTime: string },
  userId: Id<"users">,
  nowMs: number,
) {
  const { startUtc, endUtc } = bounds;

  // ---- Candidate tables (read set: restaurant_tables docs) ----
  let candidates = (await tablesOfRestaurant(ctx, restaurant._id)).filter(
    (t) => t.status !== "out_of_service" && t.capacity >= input.partySize,
  );
  if (input.tableId) {
    candidates = candidates.filter((t) => t._id === input.tableId);
    if (candidates.length === 0) {
      fail(ReservationErrorCode.NO_AVAILABILITY, "That table cannot host this party size.", 409);
    }
  }
  if (candidates.length === 0) {
    fail(ReservationErrorCode.NO_AVAILABILITY, "No tables fit that party size.", 409);
  }

  // ---- READ SET: reservations of the restaurant. Any concurrent commit that
  // touches these documents invalidates this transaction at commit time and
  // forces a retry whose overlap check sees the newest state. ----
  const dayRes = await ctx.db
    .query("reservations")
    .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurant._id))
    .collect();
  const active = dayRes.filter((r) => r.status !== "cancelled");

  // Best-fit: fewest conflicts, then smallest capacity that fits.
  const scored = candidates
    .map((t) => ({
      table: t,
      conflicts: active.filter(
        (r) => r.tableId === t._id && r.startTimeUtc < endUtc && r.endTimeUtc > startUtc,
      ),
    }))
    .sort((a, b) => {
      if (a.conflicts.length !== b.conflicts.length) return a.conflicts.length - b.conflicts.length;
      return a.table.capacity - b.table.capacity;
    });

  const chosen = scored.find((s) => s.conflicts.length === 0);
  if (!chosen) {
    await logAudit(ctx, {
      restaurantId: restaurant._id,
      tableId: input.tableId ?? candidates[0]._id,
      userId,
      requestedStart: startUtc,
      requestedEnd: endUtc,
      result: "conflict",
      failureReason: input.tableId ? "TABLE_CONFLICT" : "NO_AVAILABILITY",
      requestId: input.idempotencyKey ?? null,
    });
    if (input.tableId) {
      fail(
        ReservationErrorCode.TABLE_CONFLICT,
        "Sorry — this table was just reserved by another customer. Please pick another time.",
        409,
      );
    }
    fail(
      ReservationErrorCode.NO_AVAILABILITY,
      "No tables are available for that party size at that time. Try another slot.",
      409,
    );
  }

  const code = reservationCode();
  const reservationId = await ctx.db.insert("reservations", {
    restaurantId: restaurant._id,
    tableId: chosen.table._id,
    customerId: userId,
    partySize: input.partySize,
    startTimeUtc: startUtc,
    endTimeUtc: endUtc,
    status: "confirmed",
    localDate: input.date,
    localTime: input.time,
    localEndTime: bounds.endTime,
    code,
    idempotencyKey: input.idempotencyKey ?? undefined,
    createdAt: nowMs,
    updatedAt: nowMs,
  });

  // Firebase UID of the booking customer (for RTDB per-user reads).
  const customerDoc = await ctx.db.get(userId);

  if (input.idempotencyKey) {
    // Ledger row commits atomically with the reservation. Racing duplicates
    // of the same key collide here at commit, get retried by OCC, and then
    // take the replay path above.
    await ctx.db.insert("idempotency_keys", {
      key: input.idempotencyKey,
      restaurantId: restaurant._id,
      userId,
      reservationId,
      createdAt: nowMs,
    });
  }

  const auditId = await logAudit(ctx, {
    restaurantId: restaurant._id,
    tableId: chosen.table._id,
    userId,
    requestedStart: startUtc,
    requestedEnd: endUtc,
    result: "confirmed",
    failureReason: null,
    requestId: input.idempotencyKey ?? null,
  });

  scheduleMirror(ctx, {
    restaurantId: restaurant._id,
    reservationId,
    customerFirebaseUid: customerDoc?.firebaseUid ?? null,
    code,
    result: "confirmed",
    tableNumber: chosen.table.tableNumber,
    partySize: input.partySize,
    localDate: input.date,
    localTime: input.time,
    localEndTime: bounds.endTime,
    startUtc,
    endUtc,
    status: "confirmed",
    requestId: input.idempotencyKey ?? null,
  });

  return {
    reservationId,
    code,
    status: "confirmed" as ReservationStatus,
    tableId: chosen.table._id,
    tableNumber: chosen.table.tableNumber,
    startUtc,
    endUtc,
    partySize: input.partySize,
    restaurantTimezone: restaurant.timezone,
    date: input.date,
    time: input.time,
    idempotencyKey: input.idempotencyKey,
    idempotentReplay: false,
    auditId,
  };
}

/* ------------------------------------------------------------------ */
/* Cancel / modify                                                     */
/* ------------------------------------------------------------------ */

async function isRestaurantAdmin(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  restaurantId: Id<"restaurants">,
) {
  const admin = await ctx.db
    .query("restaurant_admins")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (admin && admin.restaurantId === restaurantId) return true;
  const user = await ctx.db.get(userId);
  return user?.role === "admin";
}

export const cancelReservation = mutation({
  args: { reservationId: v.id("reservations") },
  handler: async (ctx, { reservationId }) => {
    const userId = await requireUser(ctx);
    const res = await ctx.db.get(reservationId);
    if (!res) fail(ReservationErrorCode.NOT_FOUND, "We couldn't find that reservation.", 404);

    const isAdmin = await isRestaurantAdmin(ctx, userId, res.restaurantId);
    if (res.customerId !== userId && !isAdmin) {
      fail(ReservationErrorCode.FORBIDDEN, "You don't have access to this reservation.", 403);
    }
    if (res.status === "cancelled") {
      fail(ReservationErrorCode.ALREADY_CANCELLED, "This reservation is already cancelled.", 409);
    }

    await ctx.db.patch(reservationId, { status: "cancelled", updatedAt: Date.now() });
    await logAudit(ctx, {
      restaurantId: res.restaurantId,
      tableId: res.tableId,
      userId,
      requestedStart: res.startTimeUtc,
      requestedEnd: res.endTimeUtc,
      result: "cancelled",
      failureReason: null,
      requestId: null,
    });
    const table = await ctx.db.get(res.tableId);
    const customerDoc = await ctx.db.get(res.customerId);
    scheduleMirror(ctx, {
      restaurantId: res.restaurantId,
      reservationId: res._id,
      customerFirebaseUid: customerDoc?.firebaseUid ?? null,
      code: res.code,
      result: "cancelled",
      tableNumber: table?.tableNumber ?? 0,
      partySize: res.partySize,
      localDate: res.localDate,
      localTime: res.localTime,
      localEndTime: res.localEndTime,
      startUtc: res.startTimeUtc,
      endUtc: res.endTimeUtc,
      status: "cancelled",
      requestId: null,
    });
    return { ok: true as const };
  },
});

export const modifyReservation = mutation({
  args: {
    reservationId: v.id("reservations"),
    date: v.string(),
    time: v.string(),
    partySize: v.number(),
  },
  handler: async (ctx, { reservationId, date, time, partySize }) => {
    const userId = await requireUser(ctx);
    const res = await ctx.db.get(reservationId);
    if (!res) fail(ReservationErrorCode.NOT_FOUND, "We couldn't find that reservation.", 404);
    if (res.customerId !== userId) {
      fail(ReservationErrorCode.FORBIDDEN, "You don't have access to this reservation.", 403);
    }
    if (res.status === "cancelled") {
      fail(ReservationErrorCode.ALREADY_CANCELLED, "This reservation is already cancelled.", 409);
    }

    const restaurant = await ctx.db.get(res.restaurantId);
    if (!restaurant) fail(ReservationErrorCode.NOT_FOUND, "Restaurant not found.", 404);
    const hours = assertHours(restaurant.openingHours);
    const duration = restaurant.reservationDurationMin ?? 90;
    const bounds = slotBounds(date, time, duration, restaurant.timezone);

    const vres = validateSlotAgainstHours({
      date,
      time,
      endTime: bounds.endTime,
      hours,
      partySize,
      nowMs: Date.now(),
      timeZone: restaurant.timezone,
      minLeadMinutes: restaurant.minLeadMinutes ?? 15,
      maxAdvanceDays: restaurant.maxAdvanceDays ?? 60,
    });
    if (!vres.ok) {
      const code = (vres.code ?? "VALIDATION") as ReservationErrorCode;
      fail(code, vres.message ?? "Invalid reservation request.", code === "RESTAURANT_CLOSED" ? 409 : 400);
    }

    // Rebook atomically: pick a free table for the new slot (this reservation
    // excluded from the overlap check via its old start/end).
    const dayRes = await ctx.db
      .query("reservations")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", res.restaurantId))
      .collect();
    const candidates = (await tablesOfRestaurant(ctx, res.restaurantId)).filter(
      (t) => t.status !== "out_of_service" && t.capacity >= partySize,
    );

    const chosen = candidates.find(
      (t) =>
        !dayRes.some(
          (r) =>
            r._id !== res._id &&
            r.status !== "cancelled" &&
            r.tableId === t._id &&
            r.startTimeUtc < bounds.endUtc &&
            r.endTimeUtc > bounds.startUtc,
        ),
    );
    if (!chosen) {
      fail(
        ReservationErrorCode.NO_AVAILABILITY,
        "No tables are available at the new time. Try another slot.",
        409,
      );
    }

    await ctx.db.patch(reservationId, {
      tableId: chosen._id,
      partySize,
      startTimeUtc: bounds.startUtc,
      endTimeUtc: bounds.endUtc,
      localDate: date,
      localTime: time,
      localEndTime: bounds.endTime,
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      restaurantId: res.restaurantId,
      tableId: chosen._id,
      userId,
      requestedStart: bounds.startUtc,
      requestedEnd: bounds.endUtc,
      result: "modified",
      failureReason: null,
      requestId: null,
    });

    const customerDoc = await ctx.db.get(res.customerId);
    scheduleMirror(ctx, {
      restaurantId: res.restaurantId,
      reservationId: res._id,
      customerFirebaseUid: customerDoc?.firebaseUid ?? null,
      code: res.code,
      result: "modified",
      tableNumber: chosen.tableNumber,
      partySize,
      localDate: date,
      localTime: time,
      localEndTime: bounds.endTime,
      startUtc: bounds.startUtc,
      endUtc: bounds.endUtc,
      status: "confirmed",
      requestId: null,
    });

    return { ok: true as const, tableNumber: chosen.tableNumber, code: res.code };
  },
});

/* ------------------------------------------------------------------ */
/* Customer queries                                                    */
/* ------------------------------------------------------------------ */

export const listMyReservations = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_customer", (q) => q.eq("customerId", userId))
      .collect();
    rows.sort((a, b) => b.startTimeUtc - a.startTimeUtc);
    return Promise.all(
      rows.map(async (r) => {
        const restaurant = await ctx.db.get(r.restaurantId);
        const table = await ctx.db.get(r.tableId);
        return {
          _id: r._id,
          code: r.code,
          status: r.status,
          partySize: r.partySize,
          startTimeUtc: r.startTimeUtc,
          endTimeUtc: r.endTimeUtc,
          localDate: r.localDate,
          localTime: r.localTime,
          localEndTime: r.localEndTime,
          restaurantId: r.restaurantId,
          restaurantName: restaurant?.name ?? "Unknown",
          restaurantTimezone: restaurant?.timezone ?? "UTC",
          restaurantCuisine: restaurant?.cuisine ?? "",
          tableNumber: table?.tableNumber ?? 0,
          createdAt: r.createdAt,
        };
      }),
    );
  },
});

export const getReservation = query({
  args: { reservationId: v.id("reservations") },
  handler: async (ctx, { reservationId }) => {
    const userId = await requireUser(ctx);
    const res = await ctx.db.get(reservationId);
    if (!res) fail(ReservationErrorCode.NOT_FOUND, "We couldn't find that reservation.", 404);
    const restaurant = await ctx.db.get(res.restaurantId);
    const isAdmin = await isRestaurantAdmin(ctx, userId, res.restaurantId);
    if (res.customerId !== userId && !isAdmin) {
      fail(ReservationErrorCode.FORBIDDEN, "You don't have access to this reservation.", 403);
    }
    const table = await ctx.db.get(res.tableId);
    const customer = await ctx.db.get(res.customerId);
    return {
      _id: res._id,
      code: res.code,
      status: res.status,
      partySize: res.partySize,
      startTimeUtc: res.startTimeUtc,
      endTimeUtc: res.endTimeUtc,
      localDate: res.localDate,
      localTime: res.localTime,
      localEndTime: res.localEndTime,
      tableId: res.tableId,
      tableNumber: table?.tableNumber ?? 0,
      restaurantId: res.restaurantId,
      restaurantName: restaurant?.name ?? "",
      restaurantTimezone: restaurant?.timezone ?? "UTC",
      customerName: customer?.name ?? customer?.email ?? "Guest",
      createdAt: res.createdAt,
    };
  },
});

/* ------------------------------------------------------------------ */
/* Admin queries                                                       */
/* ------------------------------------------------------------------ */

export const myRestaurant = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const admin = await ctx.db
      .query("restaurant_admins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (admin) {
      const r = await ctx.db.get(admin.restaurantId);
      if (r) return r;
    }
    const user = await ctx.db.get(userId);
    if (user?.role === "admin") {
      const any = (await ctx.db.query("restaurants").order("asc").take(1))[0];
      if (any) return any;
    }
    return null;
  },
});

export const restaurantDayReservations = query({
  args: { restaurantId: v.id("restaurants"), date: v.string() },
  handler: async (ctx, { restaurantId, date }) => {
    const userId = await requireUser(ctx);
    if (!(await isRestaurantAdmin(ctx, userId, restaurantId))) {
      fail(ReservationErrorCode.FORBIDDEN, "Admins only.", 403);
    }
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId))
      .collect();
    const filtered = rows.filter((r) => r.localDate === date);
    filtered.sort((a, b) => a.startTimeUtc - b.startTimeUtc);
    return Promise.all(
      filtered.map(async (r) => {
        const table = await ctx.db.get(r.tableId);
        const customer = await ctx.db.get(r.customerId);
        return {
          _id: r._id,
          code: r.code,
          status: r.status,
          partySize: r.partySize,
          startTimeUtc: r.startTimeUtc,
          endTimeUtc: r.endTimeUtc,
          localTime: r.localTime,
          localEndTime: r.localEndTime,
          tableId: r.tableId,
          tableNumber: table?.tableNumber ?? 0,
          customerName: customer?.name ?? customer?.email ?? "Guest",
          createdAt: r.createdAt,
        };
      }),
    );
  },
});

export const adminStats = query({
  args: { restaurantId: v.id("restaurants") },
  handler: async (ctx, { restaurantId }) => {
    const userId = await requireUser(ctx);
    if (!(await isRestaurantAdmin(ctx, userId, restaurantId))) {
      fail(ReservationErrorCode.FORBIDDEN, "Admins only.", 403);
    }
    const restaurant = await ctx.db.get(restaurantId);
    if (!restaurant) fail(ReservationErrorCode.NOT_FOUND, "Restaurant not found.", 404);
    const today = todayInZone(Date.now(), restaurant.timezone);
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId))
      .collect();
    const nowMs = Date.now();
    const tables = await tablesOfRestaurant(ctx, restaurantId);
    return {
      today: rows.filter((r) => r.localDate === today && r.status === "confirmed").length,
      upcoming: rows.filter((r) => r.status === "confirmed" && r.startTimeUtc >= nowMs).length,
      cancelled: rows.filter((r) => r.status === "cancelled").length,
      total: rows.length,
      tables: tables.length,
      seats: tables.reduce((s, t) => s + t.capacity, 0),
    };
  },
});

/* ------------------------------------------------------------------ */
/* Structured audit log (observability)                                */
/* ------------------------------------------------------------------ */

async function logAudit(
  ctx: MutationCtx,
  entry: {
    restaurantId: Id<"restaurants">;
    tableId: Id<"restaurant_tables">;
    userId: Id<"users">;
    requestedStart: number;
    requestedEnd: number;
    result: string;
    failureReason: string | null;
    requestId: string | null;
  },
): Promise<string> {
  return ctx.db.insert("reservation_audit", {
    ...entry,
    createdAt: Date.now(),
  });
}

/** Dev/demo: read recent audit rows (admins only; contains ids only). */
export const recentAudit = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 50 }) => {
    const userId = await requireUser(ctx);
    const isAdmin = await isRestaurantAdminForAny(ctx, userId);
    if (!isAdmin) fail(ReservationErrorCode.FORBIDDEN, "Admins only.", 403);
    return ctx.db.query("reservation_audit").withIndex("by_creation_time").order("desc").take(limit);
  },
});

async function isRestaurantAdminForAny(ctx: QueryCtx, userId: Id<"users">) {
  const admin = await ctx.db
    .query("restaurant_admins")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (admin) return true;
  const user = await ctx.db.get(userId);
  return user?.role === "admin";
}
