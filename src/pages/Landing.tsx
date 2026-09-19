import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { UtensilsCrossed, Search, Star, MapPin, Clock, ShieldCheck, Zap, CalendarCheck } from "lucide-react";
import { useNavigate } from "react-router";
import type { Id } from "@/convex/_generated/dataModel";

type Restaurant = {
  _id: Id<"restaurants">;
  name: string;
  description: string;
  city: string;
  cuisine: string;
  priceRange: string;
  timezone: string;
  rating: number;
  ratingCount: number;
  openingHours: { weekly: { day: number; open: string | null; close: string | null }[] };
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hoursToday(r: Restaurant): string {
  // Use the restaurant's own local calendar — a Boston restaurant closed
  // "today" must reflect Boston's date, not the viewer's.
  let tzDate: string;
  try {
    tzDate = new Intl.DateTimeFormat("en-CA", { timeZone: r.timezone }).format(new Date());
  } catch {
    tzDate = todayLocalDate();
  }
  const dow = new Date(`${tzDate}T00:00:00Z`).getUTCDay();
  const e = r.openingHours?.weekly?.find((h) => h.day === dow);
  if (!e || e.open === null || e.close === null) return "Closed today";
  return `Open ${e.open}–${e.close}`;
}

function RestaurantCard({ r, i }: { r: Restaurant; i: number }) {
  const navigate = useNavigate();
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(i * 0.06, 0.4) }}
      className="group overflow-hidden rounded-xl border border-border/70 bg-card transition-shadow hover:shadow-lg"
    >
      {/* Card art: gradient derived from the restaurant name (no external images). */}
      <div className="relative h-32 w-full bg-gradient-to-br from-primary/25 via-primary/10 to-transparent">
        <div className="absolute inset-0 flex items-center justify-center">
          <UtensilsCrossed className="size-10 text-primary/50" />
        </div>
        <Badge className="absolute right-3 top-3 bg-background/80 text-foreground backdrop-blur">
          {"$".repeat(r.priceRange.length)}
        </Badge>
      </div>
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold leading-tight">{r.name}</h3>
          <span className="flex shrink-0 items-center gap-1 text-sm">
            <Star className="size-4 fill-amber-400 text-amber-400" />
            {r.rating.toFixed(1)}
            <span className="text-xs text-muted-foreground">({r.ratingCount})</span>
          </span>
        </div>
        <p className="line-clamp-2 text-sm text-muted-foreground">{r.description}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <MapPin className="size-3.5" /> {r.city} · {r.cuisine}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="size-3.5" /> {hoursToday(r)}
          </span>
        </div>
        <Button
          size="sm"
          className="mt-2 w-full cursor-pointer gap-2"
          onClick={() => navigate(`/restaurants/${r._id}`)}
        >
          <CalendarCheck className="size-4" /> Reserve a table
        </Button>
      </div>
    </motion.div>
  );
}

export default function Landing() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [cuisine, setCuisine] = useState("all");
  const [city, setCity] = useState("all");
  const [price, setPrice] = useState("all");

  const PRICE_LABELS: Record<string, string> = {
    "$": "$ · Casual",
    "$$": "$$ · Moderate",
    "$$$": "$$$ · Upscale",
    "$$$$": "$$$$ · Fine dining",
  };

  // Idempotent demo seed — no-op when data already exists.
  const seedDemoData = useMutation(api.seed.seedDemoData);
  const [seedTried, setSeedTried] = useState(false);
  useEffect(() => {
    if (seedTried) return;
    setSeedTried(true);
    void seedDemoData({});
  }, [seedTried, seedDemoData]);

  const restaurants = useQuery(api.restaurants.searchRestaurants, {
    q: q || undefined,
    cuisine: cuisine === "all" ? undefined : cuisine,
    city: city === "all" ? undefined : city,
    priceRange: price === "all" ? undefined : price,
  });
  const facets = useQuery(api.restaurants.restaurantFacets, {});

  const filtered = useMemo(() => restaurants ?? [], [restaurants]);
  const loading = restaurants === undefined;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                             */}
      {/* ---------------------------------------------------------------- */}
      <section className="relative overflow-hidden border-b border-border/60">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,--theme(--color-primary/12%),transparent_60%)]" />
        <div className="relative mx-auto flex max-w-6xl flex-col items-center px-6 py-20 text-center sm:py-28">
          <Badge variant="outline" className="mb-6 gap-1.5 border-primary/40 bg-primary/5">
            <Zap className="size-3.5 text-primary" /> Real-time availability · Zero double-bookings
          </Badge>
          <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
            Every table, <span className="text-primary">perfectly timed</span>
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg">
            TableKeeper is the reservation platform restaurants trust. Atomic booking
            means a table can never be double-booked — even when two guests reserve
            the same second.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button
              size="lg"
              className="cursor-pointer gap-2"
              onClick={() => document.getElementById("restaurant-search")?.scrollIntoView({ behavior: "smooth" })}
            >
              <Search className="size-4" /> Find a table
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="cursor-pointer"
              onClick={() => navigate(isAuthenticated ? "/dashboard" : "/auth?returnTo=%2Fdashboard")}
            >
              {isAuthenticated ? "Open dashboard" : "Sign in"}
            </Button>
          </div>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" /> Conflict-free by design
            </span>
            <span className="flex items-center gap-2">
              <Clock className="size-4 text-primary" /> Instant confirmations
            </span>
            <span className="flex items-center gap-2">
              <CalendarCheck className="size-4 text-primary" /> Free cancellation
            </span>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Search + results                                                 */}
      {/* ---------------------------------------------------------------- */}
      <section id="restaurant-search" className="mx-auto max-w-6xl px-6 py-16">
        <div className="mb-8 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Find your table tonight</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Search by name, cuisine, city or price — availability updates live.
          </p>
        </div>

        <div className="mx-auto mb-10 grid max-w-4xl gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative sm:col-span-2">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Restaurant, cuisine or city…"
              className="pl-9"
            />
          </div>
          <Select value={cuisine} onValueChange={setCuisine}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Cuisine" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cuisines</SelectItem>
              {(facets?.cuisines ?? []).map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={city} onValueChange={setCity}>
            <SelectTrigger className="w-full"><SelectValue placeholder="City" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cities</SelectItem>
              {(facets?.cities ?? []).map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={price} onValueChange={setPrice}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Price" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any price</SelectItem>
              {(facets?.priceRanges ?? []).map((p) => (
                <SelectItem key={p} value={p}>{PRICE_LABELS[p] ?? p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-3 rounded-xl border border-border/70 p-4">
                <Skeleton className="h-32 w-full rounded-lg" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/80 py-16 text-center">
            <UtensilsCrossed className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="font-medium">No restaurants match your search</p>
            <p className="mt-1 text-sm text-muted-foreground">Try a different cuisine or clear the filters.</p>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((r, i) => (
              <RestaurantCard key={r._id} r={r as Restaurant} i={i} />
            ))}
          </div>
        )}

        {/* Make the whole grid keyboard/click friendly: card buttons above
            navigate to the restaurant page; this hint keeps the flow obvious. */}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* How it works                                                     */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-t border-border/60 bg-muted/30">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            Built so a table is never double-booked
          </h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {[
              {
                title: "Pick your moment",
                body: "Choose a date, party size and time. Slots come straight from each restaurant's real tables, hours and pace of service.",
              },
              {
                title: "Book atomically",
                body: "Every reservation is a single serializable transaction. If two guests reach for the same table at once, exactly one wins — instantly and fairly.",
              },
              {
                title: "Watch it live",
                body: "Confirmations stream in real time to the restaurant's dashboard, with a unique code for every booking and free cancellation up to the hour.",
              },
            ].map((s) => (
              <div key={s.title} className="rounded-xl border border-border/70 bg-card p-6">
                <h3 className="font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{s.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Button size="lg" className="cursor-pointer gap-2" onClick={() => navigate("/auth?returnTo=%2Fdashboard")}>
              Get started free <Search className="size-4" />
            </Button>
            <p className="mt-3 text-xs text-muted-foreground">
              {todayLocalDate()} · Availability refreshes every few seconds
            </p>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/60 py-8 text-center text-xs text-muted-foreground">
        TableKeeper — reservations that never collide.
      </footer>
    </div>
  );
}
