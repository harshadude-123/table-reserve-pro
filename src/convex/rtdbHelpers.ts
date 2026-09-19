import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

/**
 * Internal auth/lookup helpers for the Firebase RTDB integration.
 * Kept out of the "use node" module because only actions may live there.
 */

export const adminRestaurantCheck = internalQuery({
  args: { userId: v.id("users"), restaurantId: v.id("restaurants") },
  handler: async (ctx, { userId, restaurantId }) => {
    const admin = await ctx.db
      .query("restaurant_admins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (admin && admin.restaurantId === restaurantId) return true;
    const user = await ctx.db.get(userId);
    return user?.role === "admin";
  },
});

export const resolveAdminRestaurant = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const admin = await ctx.db
      .query("restaurant_admins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (admin) return admin.restaurantId;
    const user = await ctx.db.get(userId);
    if (user?.role === "admin") {
      return (await ctx.db.query("restaurants").order("asc").take(1))[0]?._id ?? null;
    }
    return null;
  },
});
