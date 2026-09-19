/**
 * Development/demo-mode concurrency stress test.
 *
 * Exposed to signed-in users on the Concurrency Lab page. Fires N
 * simultaneous reserve attempts at the same table + slot using throwaway
 * visitor users, so anyone can watch the database enforce "never
 * double-book". Each attempt runs in its own serializable transaction;
 * Convex's optimistic concurrency control serializes them at commit, so
 * exactly one can win.
 */

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { localToUtcMs, addMinutesToTime } from "../lib/tz";

export interface AttemptOutcome {
  outcome: "confirmed" | "conflict" | "error";
  error?: string;
}

export interface ConcurrencyTestReport {
  requestsSent: number;
  succeeded: number;
  rejected: number;
  other: number;
  errorSamples: string[];
  reservationsAtSlot: number;
  tableId: string;
  date: string;
  time: string;
}

interface RestaurantLike {
  timezone: string;
  openingHours: { weekly: { day: number; open: string | null; close: string | null }[] };
  reservationDurationMin?: number;
}

export const run = action({
  args: {
    restaurantId: v.id("restaurants"),
    tableId: v.optional(v.id("restaurant_tables")),
    /** Local slot on some upcoming date; omitted = opening slot tomorrow. */
    date: v.optional(v.string()),
    time: v.optional(v.string()),
    n: v.optional(v.number()),
  },
  handler: async (ctx, { restaurantId, tableId, date, time, n }): Promise<ConcurrencyTestReport> => {
    const userId = (await ctx.runQuery(internal.firebaseIdentity.currentUserId, {})) as string | null;
    if (userId === null) throw new Error("Sign in to run the concurrency test.");
    const count = Math.max(2, Math.min(100, Math.floor(n ?? 20)));

    const restaurant = (await ctx.runQuery(internal.concurrencyTest.getRestaurantInternal, {
      id: restaurantId,
    })) as RestaurantLike | null;
    if (!restaurant) throw new Error("Restaurant not found.");

    // Pick the target slot: supplied date/time or the opening slot tomorrow.
    let targetDate = date ?? "";
    let targetTime = time ?? "";
    if (!targetDate || !targetTime) {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: restaurant.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      targetDate = fmt.format(tomorrow);
      const dow = new Date(`${targetDate}T00:00:00Z`).getUTCDay();
      const entry = restaurant.openingHours.weekly.find((h) => h.day === dow);
      if (!entry || !entry.open) {
        throw new Error("Restaurant is closed tomorrow — pick a date/time explicitly.");
      }
      targetTime = entry.open;
    }

    // Resolve table: explicit or the smallest-capacity one.
    let targetTableId: Id<"restaurant_tables"> | undefined = tableId;
    if (!targetTableId) {
      const tables = (await ctx.runQuery(internal.concurrencyTest.listTablesInternal, {
        restaurantId,
      })) as { _id: Id<"restaurant_tables">; capacity: number }[];
      const sorted = [...tables].sort((a, b) => a.capacity - b.capacity);
      if (sorted.length === 0) throw new Error("Restaurant has no tables.");
      targetTableId = sorted[0]._id;
    }
    if (!targetTableId) throw new Error("Restaurant has no tables.");

    // Pre-check: slot must be free, otherwise every attempt just conflicts.
    const pre = (await ctx.runQuery(internal.concurrencyTest.overlapCheck, {
      restaurantId,
      tableId: targetTableId,
      date: targetDate,
      time: targetTime,
    })) as { free: boolean };
    if (!pre.free) {
      throw new Error("Target slot is already booked — pick another slot for the test.");
    }

    const attempts: AttemptOutcome[] = await Promise.all(
      Array.from({ length: count }, () =>
        ctx.runAction(internal.concurrencyTest.singleAttempt, {
          restaurantId,
          tableId: targetTableId as Id<"restaurant_tables">,
          date: targetDate,
          time: targetTime,
        }),
      ),
    );

    const succeeded = attempts.filter((r) => r.outcome === "confirmed").length;
    const rejected = attempts.filter((r) => r.outcome === "conflict").length;
    const errors = attempts.filter((r) => r.outcome === "error");
    const duplicates = (await ctx.runQuery(internal.concurrencyTest.countReservationsAt, {
      restaurantId,
      tableId: targetTableId as Id<"restaurant_tables">,
      date: targetDate,
      time: targetTime,
    })) as number;

    return {
      requestsSent: count,
      succeeded,
      rejected,
      other: errors.length,
      errorSamples: errors.slice(0, 3).map((e) => e.error ?? "unknown"),
      reservationsAtSlot: duplicates,
      tableId: targetTableId,
      date: targetDate,
      time: targetTime,
    };
  },
});

/** One visitor's booking attempt, in its own action (own mutations). */
export const singleAttempt = internalAction({
  args: {
    restaurantId: v.id("restaurants"),
    tableId: v.id("restaurant_tables"),
    date: v.string(),
    time: v.string(),
  },
  handler: async (ctx, { restaurantId, tableId, date, time }): Promise<AttemptOutcome> => {
    try {
      const outcome = (await ctx.runMutation(internal.concurrencyTest.attemptReserve, {
        restaurantId,
        tableId,
        date,
        time,
      })) as { outcome: "confirmed" };
      return outcome;
    } catch (e) {
      const msg = String(e);
      if (/TABLE_CONFLICT|NO_AVAILABILITY/.test(msg)) {
        return { outcome: "conflict" };
      }
      return { outcome: "error", error: msg.slice(0, 200) };
    }
  },
});

/**
 * Insert a throwaway visitor, then run the overlap-check + insert as one
 * mutation. Same serializable check-then-insert unit as reserveAtomic,
 * driven by an internal caller (no auth session needed).
 */
export const attemptReserve = internalMutation({
  args: {
    restaurantId: v.id("restaurants"),
    tableId: v.id("restaurant_tables"),
    date: v.string(),
    time: v.string(),
  },
  handler: async (ctx, { restaurantId, tableId, date, time }): Promise<{ outcome: "confirmed" }> => {
    const email = `visitor-${crypto.randomUUID()}@concurrency.test`;
    const userId = await ctx.db.insert("users", { email, name: "Concurrency Visitor" });

    const restaurant = await ctx.db.get(restaurantId);
    if (!restaurant) throw new Error("Restaurant not found.");

    const startUtc = localToUtcMs(date, time, restaurant.timezone);
    if (startUtc === null) throw new Error("Bad slot for test.");
    const endUtc = startUtc + (restaurant.reservationDurationMin ?? 90) * 60_000;

    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_table", (q) => q.eq("tableId", tableId))
      .collect();
    const active = rows.filter((r) => r.status !== "cancelled");

    const conflict = active.some((r) => r.startTimeUtc < endUtc && r.endTimeUtc > startUtc);
    if (conflict) {
      throw new Error(
        'RESERVATION_ERROR:{"code":"TABLE_CONFLICT","message":"table taken","httpStatus":409}',
      );
    }

    await ctx.db.insert("reservations", {
      restaurantId,
      tableId,
      customerId: userId,
      partySize: 2,
      startTimeUtc: startUtc,
      endTimeUtc: endUtc,
      status: "confirmed",
      localDate: date,
      localTime: time,
      localEndTime: addMinutesToTime(time, restaurant.reservationDurationMin ?? 90) ?? "23:59",
      code: `TK-TEST-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { outcome: "confirmed" };
  },
});

/* --- internal queries ------------------------------------------------- */

export const getRestaurantInternal = internalQuery({
  args: { id: v.id("restaurants") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const listTablesInternal = internalQuery({
  args: { restaurantId: v.id("restaurants") },
  handler: async (ctx, { restaurantId }) =>
    ctx.db
      .query("restaurant_tables")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId))
      .collect(),
});

export const overlapCheck = internalQuery({
  args: {
    restaurantId: v.id("restaurants"),
    tableId: v.id("restaurant_tables"),
    date: v.string(),
    time: v.string(),
  },
  handler: async (ctx, { restaurantId, tableId, date, time }): Promise<{ free: boolean }> => {
    const restaurant = await ctx.db.get(restaurantId);
    if (!restaurant) return { free: true };
    const startUtc = localToUtcMs(date, time, restaurant.timezone);
    if (startUtc === null) return { free: true };
    const endUtc = startUtc + (restaurant.reservationDurationMin ?? 90) * 60_000;
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_table", (q) => q.eq("tableId", tableId))
      .collect();
    const conflict = rows.some(
      (r) => r.status !== "cancelled" && r.startTimeUtc < endUtc && r.endTimeUtc > startUtc,
    );
    return { free: !conflict };
  },
});

export const countReservationsAt = internalQuery({
  args: {
    restaurantId: v.id("restaurants"),
    tableId: v.id("restaurant_tables"),
    date: v.string(),
    time: v.string(),
  },
  handler: async (ctx, { restaurantId, tableId, date, time }): Promise<number> => {
    const restaurant = await ctx.db.get(restaurantId);
    if (!restaurant) return 0;
    const startUtc = localToUtcMs(date, time, restaurant.timezone);
    if (startUtc === null) return 0;
    const endUtc = startUtc + (restaurant.reservationDurationMin ?? 90) * 60_000;
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_table", (q) => q.eq("tableId", tableId))
      .collect();
    return rows.filter(
      (r) => r.status !== "cancelled" && r.startTimeUtc < endUtc && r.endTimeUtc > startUtc,
    ).length;
  },
});
