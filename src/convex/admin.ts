import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { encodeReservationError, ReservationErrorCode, reservationError } from "../lib/errors";
import { getAuthUserId } from "@convex-dev/auth/server";

function fail(code: ReservationErrorCode, message: string, httpStatus = 400): never {
  throw encodeReservationError(reservationError(code, message, httpStatus));
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatHoursSummary(weekly: { day: number; open: string | null; close: string | null }[]): string {
  return weekly
    .map((e) =>
      e.open && e.close ? `${WEEKDAY_SHORT[e.day]} ${e.open}–${e.close}` : `${WEEKDAY_SHORT[e.day]} closed`,
    )
    .join(" · ");
}

async function requireAdmin(ctx: MutationCtx): Promise<{
  userId: string;
  restaurantId: string | null;
}> {
  const userId = (await getAuthUserId(ctx)) as unknown as string;
  if (userId === null) fail(ReservationErrorCode.UNAUTHENTICATED, "Sign in to continue.", 401);

  const admin = await ctx.db
    .query("restaurant_admins")
    .withIndex("by_user", (q) => q.eq("userId", userId as any))
    .unique();
  if (admin) return { userId, restaurantId: admin.restaurantId as unknown as string };

  const user = await ctx.db.get(userId as any);
  if (user?.role === "admin") return { userId, restaurantId: null };

  fail(ReservationErrorCode.FORBIDDEN, "Restaurant admins only.", 403);
}

/** Admin's restaurant + tables + hours in one payload for the dashboard. */
export const myRestaurantWorkspace = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as any;
    if (userId === null) return null;

    const admin = await ctx.db
      .query("restaurant_admins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    let restaurantId: any = admin?.restaurantId ?? null;

    if (!restaurantId) {
      const user = await ctx.db.get(userId);
      if (user?.role !== "admin") return null;
      const any = (await ctx.db.query("restaurants").order("asc").take(1))[0];
      restaurantId = any?._id ?? null;
    }
    if (!restaurantId) return null;

    const restaurant = await ctx.db.get(restaurantId);
    if (!restaurant) return null;

    const tables = await ctx.db
      .query("restaurant_tables")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId))
      .collect();
    tables.sort((a, b) => a.tableNumber - b.tableNumber);

    return { restaurant, tables };
  },
});

const hoursEntryValidator = v.object({
  day: v.number(),
  open: v.union(v.string(), v.null()),
  close: v.union(v.string(), v.null()),
});

function validateHours(weekly: { day: number; open: string | null; close: string | null }[]) {
  if (!Array.isArray(weekly) || weekly.length !== 7) {
    fail(ReservationErrorCode.VALIDATION, "Hours must contain exactly 7 day entries.");
  }
  for (const e of weekly) {
    if (!Number.isInteger(e.day) || e.day < 0 || e.day > 6) {
      fail(ReservationErrorCode.VALIDATION, "Invalid day of week.");
    }
    const closed = e.open === null || e.close === null;
    if (!closed) {
      const t = /^([01]\d|2[0-3]):[0-5]\d$/.test(e.open) && /^([01]\d|2[0-3]):[0-5]\d$/.test(e.close);
      if (!t) fail(ReservationErrorCode.VALIDATION, "Hours must be HH:MM strings.");
    }
  }
}

export const updateHours = mutation({
  args: { weekly: v.array(hoursEntryValidator) },
  handler: async (ctx, { weekly }) => {
    const { restaurantId } = await requireAdmin(ctx);
    if (!restaurantId) fail(ReservationErrorCode.FORBIDDEN, "No restaurant assigned.", 403);
    validateHours(weekly);

    const restaurant = await ctx.db.get(restaurantId as any);
    if (!restaurant) fail(ReservationErrorCode.NOT_FOUND, "Restaurant not found.", 404);

    await ctx.db.patch(restaurantId, { openingHours: { weekly } });
    const mirror = await ctx.db
      .query("restaurant_hours")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId as any))
      .unique();
    if (mirror) {
      await ctx.db.patch(mirror._id, { weekly, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("restaurant_hours", { restaurantId, weekly, updatedAt: Date.now() });
    }
    return { ok: true as const };
  },
});

export const updateRestaurantInfo = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    address: v.string(),
    city: v.string(),
    cuisine: v.string(),
    priceRange: v.string(),
    timezone: v.string(),
    reservationDurationMin: v.number(),
    slotStepMin: v.number(),
    minLeadMinutes: v.number(),
    maxAdvanceDays: v.number(),
  },
  handler: async (ctx, input) => {
    const { restaurantId } = await requireAdmin(ctx);
    if (!restaurantId) fail(ReservationErrorCode.FORBIDDEN, "No restaurant assigned.", 403);

    if (input.name.trim().length < 2) fail(ReservationErrorCode.VALIDATION, "Name is too short.");
    if (!["$", "$$", "$$$", "$$$$"].includes(input.priceRange)) {
      fail(ReservationErrorCode.VALIDATION, "Price range must be $, $$, $$$ or $$$$.");
    }
    if (input.reservationDurationMin < 30 || input.reservationDurationMin > 240) {
      fail(ReservationErrorCode.VALIDATION, "Reservation duration must be 30–240 minutes.");
    }
    if (input.slotStepMin < 10 || input.slotStepMin > 120) {
      fail(ReservationErrorCode.VALIDATION, "Slot spacing must be 10–120 minutes.");
    }
    if (input.minLeadMinutes < 0 || input.minLeadMinutes > 1440) {
      fail(ReservationErrorCode.VALIDATION, "Minimum notice must be 0–1440 minutes.");
    }
    if (input.maxAdvanceDays < 1 || input.maxAdvanceDays > 365) {
      fail(ReservationErrorCode.VALIDATION, "Advance window must be 1–365 days.");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
    } catch {
      fail(ReservationErrorCode.VALIDATION, "Invalid IANA timezone.");
    }

    await ctx.db.patch(restaurantId, input);
    return { ok: true as const };
  },
});

export const addTable = mutation({
  args: { capacity: v.number() },
  handler: async (ctx, { capacity }) => {
    const { restaurantId } = await requireAdmin(ctx);
    if (!restaurantId) fail(ReservationErrorCode.FORBIDDEN, "No restaurant assigned.", 403);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) {
      fail(ReservationErrorCode.VALIDATION, "Capacity must be between 1 and 20.");
    }
    const existing = await ctx.db
      .query("restaurant_tables")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId as any))
      .collect();
    if (existing.length >= 60) fail(ReservationErrorCode.VALIDATION, "Too many tables.");
    const nextNumber = existing.reduce((m, t) => Math.max(m, t.tableNumber), 0) + 1;

    const id = await ctx.db.insert("restaurant_tables", {
      restaurantId,
      tableNumber: nextNumber,
      capacity,
      status: "active",
      createdAt: Date.now(),
    });
    return { tableId: id, tableNumber: nextNumber };
  },
});

export const updateTable = mutation({
  args: { tableId: v.id("restaurant_tables"), capacity: v.number() },
  handler: async (ctx, { tableId, capacity }) => {
    const { restaurantId } = await requireAdmin(ctx);
    if (!restaurantId) fail(ReservationErrorCode.FORBIDDEN, "No restaurant assigned.", 403);
    const table = await ctx.db.get(tableId);
    if (!table || table.restaurantId !== restaurantId) {
      fail(ReservationErrorCode.FORBIDDEN, "That table is not in your restaurant.", 403);
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) {
      fail(ReservationErrorCode.VALIDATION, "Capacity must be between 1 and 20.");
    }
    await ctx.db.patch(tableId, { capacity });
    return { ok: true as const };
  },
});

export const removeTable = mutation({
  args: { tableId: v.id("restaurant_tables") },
  handler: async (ctx, { tableId }) => {
    const { restaurantId } = await requireAdmin(ctx);
    if (!restaurantId) fail(ReservationErrorCode.FORBIDDEN, "No restaurant assigned.", 403);
    const table = await ctx.db.get(tableId);
    if (!table || table.restaurantId !== restaurantId) {
      fail(ReservationErrorCode.FORBIDDEN, "That table is not in your restaurant.", 403);
    }
    // Guard: refuse removal when future confirmed reservations exist.
    const future = await ctx.db
      .query("reservations")
      .withIndex("by_table", (q) => q.eq("tableId", tableId!))
      .collect();
    const nowMs = Date.now();
    const activeFuture = future.filter(
      (r) => r.status === "confirmed" && r.endTimeUtc > nowMs,
    );
    if (activeFuture.length > 0) {
      fail(
        ReservationErrorCode.VALIDATION,
        "This table has upcoming reservations. Cancel them first.",
        409,
      );
    }
    await ctx.db.delete(tableId);
    return { ok: true as const };
  },
});

/** Admin cancels any reservation in their restaurant. */
export const adminCancelReservation = mutation({
  args: { reservationId: v.id("reservations") },
  handler: async (ctx, { reservationId }) => {
    const { restaurantId } = await requireAdmin(ctx);
    const res = await ctx.db.get(reservationId);
    if (!res) fail(ReservationErrorCode.NOT_FOUND, "We couldn't find that reservation.", 404);
    if (restaurantId && res.restaurantId !== restaurantId) {
      fail(ReservationErrorCode.WRONG_RESTAURANT, "This reservation belongs to another restaurant.", 403);
    }
    if (res.status === "cancelled") {
      fail(ReservationErrorCode.ALREADY_CANCELLED, "Already cancelled.", 409);
    }
    await ctx.db.patch(reservationId, { status: "cancelled", updatedAt: Date.now() });
    await ctx.db.insert("reservation_audit", {
      restaurantId: res.restaurantId,
      tableId: res.tableId,
      userId: res.customerId,
      requestedStart: res.startTimeUtc,
      requestedEnd: res.endTimeUtc,
      result: "cancelled",
      failureReason: null,
      requestId: null,
      createdAt: Date.now(),
    });
    return { ok: true as const };
  },
});
