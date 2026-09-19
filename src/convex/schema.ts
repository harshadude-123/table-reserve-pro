import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const hoursEntry = v.object({
  /** 0 = Sunday … 6 = Saturday */
  day: v.number(),
  /** Local wall clock "HH:MM"; null = closed */
  open: v.union(v.string(), v.null()),
  /** Local wall clock "HH:MM" (exclusive); may cross midnight */
  close: v.union(v.string(), v.null()),
});

const openingHours = v.object({ weekly: v.array(hoursEntry) });

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove

      /** Demo-profile claim marker for one-click demo accounts. */
      demoRole: v.optional(v.union(v.literal("customer"), v.literal("owner"))),

      /** Firebase Auth UID — set when the user signs in via Firebase Auth. */
      firebaseUid: v.optional(v.string()),
    }).index("email", ["email"]) // index for the email. do not remove or modify
      .index("firebaseUid", ["firebaseUid"]),

    /* ------------------------------------------------------------------ */
    /* TableKeeper domain                                                  */
    /* ------------------------------------------------------------------ */

    restaurants: defineTable({
      name: v.string(),
      description: v.string(),
      address: v.string(),
      city: v.string(),
      cuisine: v.string(),
      /** "$" | "$$" | "$$$" | "$$$$" */
      priceRange: v.string(),
      /** IANA timezone — the restaurant's local time. */
      timezone: v.string(),
      /** Weekly opening hours in restaurant-local wall clock. */
      openingHours: openingHours,
      /** Minutes a table is held per reservation. */
      reservationDurationMin: v.number(),
      /** Slot grid spacing in minutes. */
      slotStepMin: v.number(),
      /** Minimum notice before a reservation can start. */
      minLeadMinutes: v.number(),
      /** Max days ahead for bookings. */
      maxAdvanceDays: v.number(),
      /** Denormalized review aggregate, refreshed on review writes. */
      rating: v.number(),
      ratingCount: v.number(),
      /** Visual theme seed for the card art. */
      imageSeed: v.string(),
      isActive: v.boolean(),
      createdAt: v.number(),
    }).index("by_isActive", ["isActive"]),

    restaurant_tables: defineTable({
      restaurantId: v.id("restaurants"),
      tableNumber: v.number(),
      capacity: v.number(),
      /** "active" | "out_of_service" */
      status: v.string(),
      createdAt: v.number(),
    }).index("by_restaurant", ["restaurantId"]),

    reservations: defineTable({
      restaurantId: v.id("restaurants"),
      tableId: v.id("restaurant_tables"),
      customerId: v.id("users"),
      partySize: v.number(),
      /** UTC epoch ms — the single source of truth for scheduling. */
      startTimeUtc: v.number(),
      endTimeUtc: v.number(),
      /** "confirmed" | "cancelled" | "completed" */
      status: v.string(),
      /** Restaurant-local wall clock copies for fast day queries. */
      localDate: v.string(),
      localTime: v.string(),
      localEndTime: v.string(),
      /** Human confirmation code, e.g. TK-7QF3XKA. */
      code: v.string(),
      /** Client-generated idempotency key (unique via idempotency_keys too). */
      idempotencyKey: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_restaurant", ["restaurantId", "startTimeUtc"])
      .index("by_table", ["tableId", "startTimeUtc"])
      .index("by_customer", ["customerId", "startTimeUtc"])
      .index("by_code", ["code"]),

    /** Idempotency ledger: one row per accepted reserve request key. */
    idempotency_keys: defineTable({
      key: v.string(),
      restaurantId: v.id("restaurants"),
      userId: v.id("users"),
      reservationId: v.id("reservations"),
      createdAt: v.number(),
    }).index("by_key", ["key"]),

    /** Structured reservation audit trail (no PII beyond ids). */
    reservation_audit: defineTable({
      restaurantId: v.id("restaurants"),
      tableId: v.id("restaurant_tables"),
      userId: v.id("users"),
      requestedStart: v.number(),
      requestedEnd: v.number(),
      /** "confirmed" | "conflict" | "cancelled" | "modified" | "idempotent_replay" */
      result: v.string(),
      failureReason: v.union(v.string(), v.null()),
      requestId: v.union(v.string(), v.null()),
      createdAt: v.number(),
    }),

    /** Restaurant-owner accounts (role-based access). */
    restaurant_admins: defineTable({
      userId: v.id("users"),
      restaurantId: v.id("restaurants"),
      createdAt: v.number(),
    }).index("by_user", ["userId"]),

    restaurant_hours: defineTable({
      restaurantId: v.id("restaurants"),
      /** Mirror of restaurants.openingHours for entity completeness/reporting. */
      weekly: v.array(hoursEntry),
      updatedAt: v.number(),
    }).index("by_restaurant", ["restaurantId"]),

    reviews: defineTable({
      restaurantId: v.id("restaurants"),
      authorName: v.string(),
      rating: v.number(),
      comment: v.string(),
      createdAt: v.number(),
    }).index("by_restaurant", ["restaurantId"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
