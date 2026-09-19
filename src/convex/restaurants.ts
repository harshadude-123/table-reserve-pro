import { query } from "./_generated/server";
import { v } from "convex/values";

/** Public restaurant discovery: search + filters. */
export const searchRestaurants = query({
  args: {
    q: v.optional(v.string()),
    cuisine: v.optional(v.string()),
    priceRange: v.optional(v.string()),
    city: v.optional(v.string()),
  },
  handler: async (ctx, { q, cuisine, priceRange, city }) => {
    const all = await ctx.db
      .query("restaurants")
      .withIndex("by_isActive", (c) => c.eq("isActive", true))
      .collect();

    const needle = (q ?? "").trim().toLowerCase();
    return all
      .filter((r) => {
        if (cuisine && r.cuisine !== cuisine) return false;
        if (priceRange && r.priceRange !== priceRange) return false;
        if (city && r.city !== city) return false;
        if (needle) {
          const hay = `${r.name} ${r.cuisine} ${r.city} ${r.address} ${r.description}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      })
      .sort((a, b) => b.rating - a.rating);
  },
});

/** Facets for the search UI. */
export const restaurantFacets = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db
      .query("restaurants")
      .withIndex("by_isActive", (c) => c.eq("isActive", true))
      .collect();
    return {
      cuisines: [...new Set(all.map((r) => r.cuisine))].sort(),
      cities: [...new Set(all.map((r) => r.city))].sort(),
      priceRanges: [...new Set(all.map((r) => r.priceRange))].sort(),
    };
  },
});

export const getRestaurant = query({
  args: { restaurantId: v.id("restaurants") },
  handler: async (ctx, { restaurantId }) => {
    const r = await ctx.db.get(restaurantId);
    if (!r || !r.isActive) return null;
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId))
      .collect();
    reviews.sort((a, b) => b.createdAt - a.createdAt);
    return {
      ...r,
      reviews: reviews.slice(0, 6).map((rv) => ({
        _id: rv._id,
        authorName: rv.authorName,
        rating: rv.rating,
        comment: rv.comment,
        createdAt: rv.createdAt,
      })),
    };
  },
});

/** Admin-facing: tables + hours for managing a restaurant. */
export const restaurantTables = query({
  args: { restaurantId: v.id("restaurants") },
  handler: async (ctx, { restaurantId }) => {
    const tables = await ctx.db
      .query("restaurant_tables")
      .withIndex("by_restaurant", (q) => q.eq("restaurantId", restaurantId))
      .collect();
    tables.sort((a, b) => a.tableNumber - b.tableNumber);
    return tables;
  },
});
