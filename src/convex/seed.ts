import { mutation } from "./_generated/server";

/**
 * Demo seed: realistic restaurants, tables, opening hours and reviews.
 * Idempotent — only inserts when the restaurants table is empty, so it can be
 * called on landing-page mount without duplicating data.
 */

interface SeedRestaurant {
  name: string;
  description: string;
  address: string;
  city: string;
  cuisine: string;
  priceRange: string;
  timezone: string;
  imageSeed: string;
  open: string;
  close: string;
  tables: number[];
  reviews: { authorName: string; rating: number; comment: string }[];
}

const RESTAURANTS: SeedRestaurant[] = [
  {
    name: "The Gilded Fork",
    description:
      "Seasonal tasting menus in a candlelit dining room. Chef Marlow's eight-course journey changes with the market.",
    address: "214 Beacon Street",
    city: "Boston",
    cuisine: "Contemporary American",
    priceRange: "$$$$",
    timezone: "America/New_York",
    imageSeed: "gilded-fork",
    open: "17:00",
    close: "22:30",
    tables: [2, 2, 4, 4, 4, 6, 6, 8],
    reviews: [
      { authorName: "Dana R.", rating: 5, comment: "The tasting menu is the best meal I've had in years." },
      { authorName: "Omar S.", rating: 5, comment: "Impeccable service and a gorgeous room." },
      { authorName: "Priya K.", rating: 4, comment: "Wonderful date night. Book well ahead!" },
    ],
  },
  {
    name: "Casa Verde",
    description:
      "Wood-fired Oaxacan cooking and a mezcal list curated by maestra Lilia Cruz. Lively, warm, unmissable.",
    address: "812 Mission Street",
    city: "San Francisco",
    cuisine: "Mexican",
    priceRange: "$$",
    timezone: "America/Los_Angeles",
    imageSeed: "casa-verde",
    open: "12:00",
    close: "22:00",
    tables: [2, 2, 2, 4, 4, 4, 6, 10],
    reviews: [
      { authorName: "Jake M.", rating: 5, comment: "The tlayudas alone are worth the trip." },
      { authorName: "Sofia L.", rating: 4, comment: "Great mezcal pairings, cozy atmosphere." },
    ],
  },
  {
    name: "Blue Lantern Ramen",
    description:
      "Tokyo-style counter ramen with 18-hour broths. Nine seats, one focus, zero shortcuts.",
    address: "45 Harbor Lane",
    city: "New York",
    cuisine: "Japanese",
    priceRange: "$",
    timezone: "America/New_York",
    imageSeed: "blue-lantern",
    open: "11:30",
    close: "21:30",
    tables: [1, 1, 2, 2, 2, 4],
    reviews: [
      { authorName: "Ken T.", rating: 5, comment: "Shoyu broth that rivals my trip to Shinjuku." },
      { authorName: "Mara J.", rating: 5, comment: "Cheap, fast, incredible. A neighborhood gem." },
    ],
  },
  {
    name: "Osteria d'Oro",
    description:
      "Handmade pasta, Roman classics, and a cellar of 200 Italian wines. Family-run since 1987.",
    address: "17 Trastevere Walk",
    city: "Chicago",
    cuisine: "Italian",
    priceRange: "$$$",
    timezone: "America/Chicago",
    imageSeed: "osteria-oro",
    open: "17:30",
    close: "23:00",
    tables: [2, 2, 4, 4, 4, 4, 6, 6, 12],
    reviews: [
      { authorName: "Elena B.", rating: 5, comment: "Cacio e pepe done perfectly. Nonna approved." },
      { authorName: "Tom W.", rating: 4, comment: "Great wine list, lively on weekends." },
    ],
  },
  {
    name: "Saffron & Smoke",
    description:
      "Modern Indian kitchen pairing tandoor smoke with regional spice blends. The tasting flight is a revelation.",
    address: "96 Curry Mile",
    city: "London",
    cuisine: "Indian",
    priceRange: "$$$",
    timezone: "Europe/London",
    imageSeed: "saffron-smoke",
    open: "18:00",
    close: "23:00",
    tables: [2, 2, 4, 4, 6, 6, 8],
    reviews: [
      { authorName: "Amir H.", rating: 5, comment: "The smoked lamb seekh kebab is extraordinary." },
      { authorName: "Lucy P.", rating: 4, comment: "Bold flavors, attentive staff." },
    ],
  },
  {
    name: "Le Petit Zinc",
    description:
      "A corner bistro serving timeless French fare — steak frites, duck confit, and a proper tarte tatin.",
    address: "3 Rue des Lilas",
    city: "Paris",
    cuisine: "French",
    priceRange: "$$",
    timezone: "Europe/Paris",
    imageSeed: "petit-zinc",
    open: "12:00",
    close: "22:30",
    tables: [2, 2, 2, 4, 4, 6],
    reviews: [
      { authorName: "Claire D.", rating: 5, comment: "Exactly what a Paris bistro should be." },
    ],
  },
];

function hours(open: string, close: string) {
  return {
    weekly: Array.from({ length: 7 }, (_, day) => ({
      day,
      open: day === 1 ? null : open, // closed Mondays
      close: day === 1 ? null : close,
    })),
  };
}

export const seedDemoData = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("restaurants").collect();
    if (existing.length > 0) {
      return { seeded: false as const, restaurantCount: existing.length };
    }

    const now = Date.now();
    for (const r of RESTAURANTS) {
      const ratingSum = r.reviews.reduce((s, rv) => s + rv.rating, 0);
      const ratingCount = r.reviews.length;
      const restaurantId = await ctx.db.insert("restaurants", {
        name: r.name,
        description: r.description,
        address: r.address,
        city: r.city,
        cuisine: r.cuisine,
        priceRange: r.priceRange,
        timezone: r.timezone,
        openingHours: hours(r.open, r.close),
        reservationDurationMin: 90,
        slotStepMin: 30,
        minLeadMinutes: 15,
        maxAdvanceDays: 60,
        rating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0,
        ratingCount,
        imageSeed: r.imageSeed,
        isActive: true,
        createdAt: now,
      });

      for (let i = 0; i < r.tables.length; i++) {
        await ctx.db.insert("restaurant_tables", {
          restaurantId,
          tableNumber: i + 1,
          capacity: r.tables[i],
          status: "active",
          createdAt: now,
        });
      }

      for (const rv of r.reviews) {
        await ctx.db.insert("reviews", {
          restaurantId,
          authorName: rv.authorName,
          rating: rv.rating,
          comment: rv.comment,
          createdAt: now - Math.floor(Math.random() * 30) * 86_400_000,
        });
      }

      await ctx.db.insert("restaurant_hours", {
        restaurantId,
        weekly: hours(r.open, r.close).weekly,
        updatedAt: now,
      });
    }

    return { seeded: true as const, restaurantCount: RESTAURANTS.length };
  },
});
