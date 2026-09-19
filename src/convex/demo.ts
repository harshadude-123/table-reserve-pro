import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { resolveUserId } from "./firebaseIdentity";

/**
 * Demo-profile claiming: the Auth page offers one-click "Demo customer" and
 * "Demo owner" buttons. The client generates a random email like
 * demo-customer-8f3k2@tablekeeper.demo, signs in with email-OTP (dev codes
 * surface directly in the Convex dashboard / auth flow without email
 * delivery in dev), and then claims the role here — tagging the fresh user
 * document and, for owners, linking them to the demo restaurant.
 *
 * Claiming is idempotent per user and safe to call right after sign-in.
 */

/** Mark current user as demo customer (idempotent). */
export const claimCustomer = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await resolveUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User missing.");
    if (user.role !== "admin" && user.demoRole !== "customer") {
      await ctx.db.patch(userId, { demoRole: "customer", role: "user" });
    }
    return { ok: true as const };
  },
});

/**
 * Mark current user as demo owner and attach the demo restaurant. Uses an
 * internal helper so the seed can also create the canonical owner link.
 */
export const claimOwner = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await resolveUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User missing.");

    const any = (await ctx.db.query("restaurants").order("asc").take(1))[0];
    if (!any) throw new Error("Run the seed first: bun run scripts/seed.ts");

    const existing = await ctx.db
      .query("restaurant_admins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    await ctx.db.patch(userId, { demoRole: "owner", role: "admin" });
    if (!existing) {
      await ctx.db.insert("restaurant_admins", {
        userId,
        restaurantId: any._id,
        createdAt: Date.now(),
      });
    }
    return { ok: true as const, restaurantId: any._id };
  },
});

/** Internal: used by the seed script to wire the canonical demo accounts. */
export const linkOwnerInternal = internalMutation({
  args: { userId: v.id("users"), restaurantId: v.id("restaurants") },
  handler: async (ctx, { userId, restaurantId }) => {
    const existing = await ctx.db
      .query("restaurant_admins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!existing) {
      await ctx.db.insert("restaurant_admins", { userId, restaurantId, createdAt: Date.now() });
    }
    await ctx.db.patch(userId, { role: "admin" });
    return { ok: true as const };
  },
});

/** Debug helper (dev): count documents per table. */
export const counts = query({
  args: {},
  handler: async (ctx) => {
    const [restaurants, tables, reservations, users] = await Promise.all([
      ctx.db.query("restaurants").collect(),
      ctx.db.query("restaurant_tables").collect(),
      ctx.db.query("reservations").collect(),
      ctx.db.query("users").collect(),
    ]);
    return {
      restaurants: restaurants.length,
      tables: tables.length,
      reservations: reservations.length,
      users: users.length,
    };
  },
});
