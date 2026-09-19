import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import {
  decodeReservationError,
  isStaleAvailabilityError,
} from "@/lib/errors";
import { formatWallTime } from "@/lib/tz";
import {
  ArrowLeft,
  CalendarCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Minus,
  Plus,
  Star,
  UtensilsCrossed,
  Users,
} from "lucide-react";

const MINUTE = 60_000;

type Restaurant = {
  _id: Id<"restaurants">;
  name: string;
  description: string;
  address: string;
  city: string;
  cuisine: string;
  priceRange: string;
  timezone: string;
  rating: number;
  ratingCount: number;
  reservationDurationMin: number;
  slotStepMin: number;
  openingHours: { weekly: { day: number; open: string | null; close: string | null }[] };
  reviews: { _id: string; authorName: string; rating: number; comment: string; createdAt: number }[];
};

type Slot = { time: string; availableTables: number; available: boolean };

type ConfirmResult = {
  reservationId: string;
  code: string;
  status: string;
  tableNumber: number;
  startUtc: number;
  endUtc: number;
  partySize: number;
  restaurantTimezone: string;
  date: string;
  time: string;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayInZone(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA").format(new Date());
  }
}

function addDays(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function shortLabel(date: string): { dow: string; md: string } {
  const dt = new Date(`${date}T00:00:00Z`);
  return {
    dow: DAYS[dt.getUTCDay()],
    md: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`,
  };
}

function prettyDate(date: string): string {
  const dt = new Date(`${date}T00:00:00Z`);
  return dt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function hoursToday(r: Restaurant, tz: string): string {
  const dow = new Date(`${todayInZone(tz)}T00:00:00Z`).getUTCDay();
  const e = r.openingHours?.weekly?.find((h) => h.day === dow);
  if (!e || e.open === null || e.close === null) return "Closed today";
  return `Open ${formatWallTime(e.open)} – ${formatWallTime(e.close)}`;
}

function weekdayChipLabel(date: string): string {
  const dt = new Date(`${date}T00:00:00Z`);
  return dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

export default function RestaurantPage() {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const id = restaurantId as Id<"restaurants"> | undefined;

  const restaurant = useQuery(
    api.restaurants.getRestaurant,
    id ? { restaurantId: id } : "skip",
  );
  const [date, setDate] = useState<string>(() =>
    id ? todayInZone("UTC") : "",
  );
  const [partySize, setPartySize] = useState(2);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState<ConfirmResult | null>(null);

  // Seed the date once the restaurant (and its timezone) is known.
  useEffect(() => {
    if (restaurant && !date) setDate(todayInZone(restaurant.timezone));
  }, [restaurant, date]);

  const availability = useQuery(
    api.reservations.getDayAvailability,
    restaurant && date && !confirmed ? { restaurantId: restaurant._id, date, partySize } : "skip",
  );

  // If the selected time is no longer available (booked by someone else),
  // drop the stale selection.
  useEffect(() => {
    if (!availability || !selectedTime) return;
    const slot = availability.slots.find((s: Slot) => s.time === selectedTime);
    if (slot && !slot.available) setSelectedTime(null);
  }, [availability, selectedTime]);

  const reserve = useMutation(api.reservations.reserveAtomic);

  const availableCount = useMemo(
    () => (availability?.slots ?? []).filter((s: Slot) => s.available).length,
    [availability],
  );

  const hourChunks = useMemo(() => {
    const slots = availability?.slots ?? [];
    const chunks: Record<string, Slot[]> = {};
    for (const s of slots) {
      const hour = s.time.slice(0, 2);
      (chunks[hour] ??= []).push(s);
    }
    return Object.entries(chunks);
  }, [availability]);

  async function handleConfirm() {
    if (!restaurant || !selectedTime) return;
    setConfirming(true);
    try {
      const result = await reserve({
        restaurantId: restaurant._id,
        date,
        time: selectedTime,
        partySize,
        idempotencyKey: `web-${crypto.randomUUID()}`,
      });
      setConfirmed(result as unknown as ConfirmResult);
      setSelectedTime(null);
      toast.success(`Reservation confirmed — ${result.code}`);
    } catch (e) {
      const decoded = decodeReservationError(e instanceof Error ? e.message : String(e));
      toast.error(decoded?.message ?? (e instanceof Error ? e.message : "Could not complete the reservation."));
      if (decoded && isStaleAvailabilityError(decoded.code)) {
        setSelectedTime(null);
      }
    } finally {
      setConfirming(false);
    }
  }

  if (restaurant === undefined) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-5xl space-y-6 px-6 py-10">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  if (restaurant === null || !id) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background text-foreground">
        <UtensilsCrossed className="mb-4 size-10 text-muted-foreground/50" />
        <h1 className="text-xl font-semibold">Restaurant not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">It may have been removed.</p>
        <Button className="mt-6 cursor-pointer" onClick={() => navigate("/")}>
          <ArrowLeft className="size-4" /> Back to search
        </Button>
      </div>
    );
  }

  const r = restaurant as unknown as Restaurant;

  /* ---------------------------------------------------------------- */
  /* Confirmation screen                                              */
  /* ---------------------------------------------------------------- */
  if (confirmed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="w-full max-w-md"
        >
          <Card className="border-emerald-500/30 shadow-lg">
            <CardHeader className="text-center">
              <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full bg-emerald-500/10">
                <CheckCircle2 className="size-7 text-emerald-500" />
              </div>
              <CardTitle className="text-2xl">You're booked!</CardTitle>
              <p className="text-sm text-muted-foreground">
                A table at {r.name} is confirmed and locked in — no one else can take it.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-border/70 bg-muted/30 p-4 text-center">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Confirmation code</p>
                <p className="mt-1 font-mono text-2xl font-bold tracking-wider">{confirmed.code}</p>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Restaurant</span>
                  <span className="font-medium">{r.name}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Date</span>
                  <span className="font-medium">{prettyDate(confirmed.date)}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Time</span>
                  <span className="font-medium">
                    {formatWallTime(confirmed.time)} – {formatWallTime(confirmed.time)} ({confirmed.tableNumber
                      ? `Table ${confirmed.tableNumber}`
                      : "table assigned at arrival"})
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Party</span>
                  <span className="font-medium">{confirmed.partySize} guests</span>
                </div>
              </div>
              <div className="flex flex-col gap-2 pt-2 sm:flex-row">
                <Button className="flex-1 cursor-pointer" onClick={() => navigate("/dashboard")}>
                  View my reservations
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 cursor-pointer"
                  onClick={() => {
                    setConfirmed(null);
                    setDate(todayInZone(r.timezone));
                    setSelectedTime(null);
                  }}
                >
                  Book another
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Booking flow                                                     */
  /* ---------------------------------------------------------------- */
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 cursor-pointer gap-1.5"
          onClick={() => navigate("/")}
        >
          <ChevronLeft className="size-4" /> All restaurants
        </Button>

        {/* Header card */}
        <div className="overflow-hidden rounded-xl border border-border/70">
          <div className="relative h-44 bg-gradient-to-br from-primary/25 via-primary/10 to-transparent">
            <div className="absolute inset-0 flex items-center justify-center">
              <UtensilsCrossed className="size-14 text-primary/40" />
            </div>
            <Badge className="absolute right-4 top-4 bg-background/80 text-foreground backdrop-blur">
              {r.priceRange}
            </Badge>
          </div>
          <div className="space-y-3 p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{r.name}</h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <MapPin className="size-4" /> {r.address}, {r.city}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="size-4" /> {hoursToday(r, r.timezone)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Star className="size-4 fill-amber-400 text-amber-400" /> {r.rating.toFixed(1)} ({r.ratingCount})
                  </span>
                </p>
              </div>
              <Badge variant="outline">{r.cuisine}</Badge>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">{r.description}</p>
          </div>
        </div>

        {/* Week strip: 14 days */}
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Select a date
          </h2>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
            {Array.from({ length: 14 }, (_, i) => addDays(todayInZone(r.timezone), i)).map((d) => {
              const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
              const entry = r.openingHours?.weekly?.find((h) => h.day === dow);
              const closed = !entry || entry.open === null || entry.close === null;
              const isSel = d === date;
              return (
                <button
                  key={d}
                  type="button"
                  disabled={closed}
                  onClick={() => {
                    setDate(d);
                    setSelectedTime(null);
                  }}
                  className={`flex min-w-[64px] shrink-0 cursor-pointer flex-col items-center rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                    isSel
                      ? "border-primary bg-primary text-primary-foreground"
                      : closed
                        ? "cursor-not-allowed border-border/50 text-muted-foreground/40"
                        : "border-border/70 bg-card hover:border-primary/50"
                  }`}
                >
                  <span className="text-xs">{weekdayChipLabel(d)}</span>
                  <span className="font-semibold">{d.slice(8, 10)}</span>
                  {closed && <span className="text-[10px]">closed</span>}
                </button>
              );
            })}
          </div>
        </section>

        {/* Party size + availability */}
        <section className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Select a time
            </h2>
            {availability === undefined ? (
              <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6">
                {Array.from({ length: 12 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : availableCount === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-border/80 py-12 text-center">
                <CalendarCheck className="mx-auto mb-3 size-8 text-muted-foreground/50" />
                <p className="font-medium">No tables available on {prettyDate(date)}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Try another date or a different party size.
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-4">
                {hourChunks.map(([hour, slots]) => (
                  <div key={hour}>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      {formatWallTime(`${hour}:00`)}
                    </p>
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                      {slots.map((s) => (
                        <button
                          key={s.time}
                          type="button"
                          disabled={!s.available}
                          onClick={() => setSelectedTime(s.time)}
                          className={`rounded-lg border px-2 py-2 text-sm transition-colors ${
                            selectedTime === s.time
                              ? "border-primary bg-primary text-primary-foreground"
                              : s.available
                                ? "border-border/70 bg-card hover:border-primary/50"
                                : "cursor-not-allowed border-border/50 text-muted-foreground/40 line-through"
                          }`}
                        >
                          {formatWallTime(s.time)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sticky summary */}
          <Card className="h-fit border-border/70 shadow-none lg:sticky lg:top-8">
            <CardHeader>
              <CardTitle className="text-base">Your reservation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Date</span>
                  <span className="font-medium">{prettyDate(date)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Time</span>
                  <span className="font-medium">{selectedTime ? formatWallTime(selectedTime) : "—"}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Timezone</span>
                  <span className="font-medium">{r.timezone.split("/").pop()?.replace("_", " ")}</span>
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm text-muted-foreground">Party size</p>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 cursor-pointer"
                    disabled={partySize <= 1}
                    onClick={() => {
                      setPartySize((p) => Math.max(1, p - 1));
                      setSelectedTime(null);
                    }}
                  >
                    <Minus className="size-4" />
                  </Button>
                  <span className="flex w-16 items-center justify-center gap-1.5 font-semibold">
                    <Users className="size-4" /> {partySize}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 cursor-pointer"
                    disabled={partySize >= 20}
                    onClick={() => {
                      setPartySize((p) => Math.min(20, p + 1));
                      setSelectedTime(null);
                    }}
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
              </div>

              {isAuthenticated ? (
                <Button
                  size="lg"
                  className="w-full cursor-pointer gap-2"
                  disabled={!selectedTime || confirming}
                  onClick={() => void handleConfirm()}
                >
                  <CalendarCheck className="size-4" />
                  {confirming ? "Confirming…" : "Confirm reservation"}
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="w-full cursor-pointer gap-2"
                  onClick={() =>
                    navigate(`/auth?returnTo=${encodeURIComponent(`/restaurants/${r._id}`)}`)
                  }
                >
                  Sign in to book
                </Button>
              )}
              <p className="text-center text-xs text-muted-foreground">
                Free cancellation from your dashboard · {r.reservationDurationMin}-min tables
              </p>
            </CardContent>
          </Card>
        </section>

        {/* Reviews */}
        {r.reviews.length > 0 && (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">What diners say</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {r.reviews.map((rv) => (
                <Card key={rv._id} className="border-border/70 shadow-none">
                  <CardContent className="pt-5">
                    <div className="flex items-center gap-1">
                      {Array.from({ length: 5 }, (_, i) => (
                        <Star
                          key={i}
                          className={`size-3.5 ${i < rv.rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
                        />
                      ))}
                    </div>
                    <p className="mt-2 text-sm leading-6">{rv.comment}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{rv.authorName}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
