import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveActivityCard } from "@/components/LiveActivityCard";
import { useAuth } from "@/hooks/use-auth";
import { formatWallTime } from "@/lib/tz";
import { Link } from "react-router";
import {
  CalendarDays,
  CalendarX2,
  Clock,
  LogOut,
  Store,
  Users,
} from "lucide-react";
import { useNavigate } from "react-router";

type MyReservation = {
  _id: string;
  code: string;
  status: string;
  partySize: number;
  startTimeUtc: number;
  localDate: string;
  localTime: string;
  localEndTime: string;
  restaurantName: string;
  restaurantCuisine: string;
  tableNumber: number;
};

interface RestaurantInfo {
  _id: Id<"restaurants">;
  name: string;
  cuisine: string;
  city: string;
  priceRange: string;
  timezone: string;
  openingHours: { weekly: { day: number; open: string | null; close: string | null }[] };
  reservationDurationMin: number;
  slotStepMin: number;
}

function todayInZone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA").format(new Date());
  }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    confirmed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    cancelled: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    completed: "bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={map[status] ?? ""}>
      {status}
    </Badge>
  );
}

function CustomerReservations() {
  const reservations = useQuery(api.reservations.listMyReservations, {});
  const cancel = useMutation(api.reservations.cancelReservation);

  if (reservations === undefined) {
    return (
      <Card className="border-border/70 shadow-none">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Loading reservations…
        </CardContent>
      </Card>
    );
  }

  const nowMs = Date.now();
  const upcoming = reservations.filter(
    (r: MyReservation) => r.status === "confirmed" && r.startTimeUtc >= nowMs,
  );
  const past = reservations.filter(
    (r: MyReservation) => r.status !== "confirmed" || r.startTimeUtc < nowMs,
  );

  return (
    <div className="space-y-6">
      <Card className="border-border/70 shadow-none">
        <CardHeader>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CalendarDays className="size-5" />
          </div>
          <CardTitle>Your upcoming reservations</CardTitle>
        </CardHeader>
        <CardContent>
          {upcoming.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">No upcoming reservations yet.</p>
              <Button asChild variant="outline" size="sm" className="mt-3 cursor-pointer">
                <Link to="/">Find a table</Link>
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {upcoming.map((r) => (
                <li key={r._id} className="flex items-center gap-4 py-4">
                  <div className="flex size-12 shrink-0 flex-col items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <span className="text-[10px] font-semibold uppercase">
                      {r.localDate.slice(5, 7)}
                    </span>
                    <span className="text-sm font-bold leading-none">
                      {r.localDate.slice(8, 10)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{r.restaurantName}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock className="size-3" />
                      {formatWallTime(r.localTime)} – {formatWallTime(r.localEndTime)}
                      <Users className="ml-1 size-3" /> {r.partySize}
                      <span>· Table {r.tableNumber}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {r.code}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="cursor-pointer gap-1.5 text-rose-600 hover:text-rose-600"
                      onClick={async () => {
                        try {
                          await cancel({ reservationId: r._id as never });
                          toast.success(`Reservation ${r.code} cancelled`);
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Could not cancel");
                        }
                      }}
                    >
                      <CalendarX2 className="size-4" /> Cancel
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {past.length > 0 && (
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">History</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border/60">
              {past.slice(0, 8).map((r) => (
                <li key={r._id} className="flex items-center gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.restaurantName}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.localDate} · {formatWallTime(r.localTime)} · {r.partySize} guests · Table{" "}
                      {r.tableNumber}
                    </p>
                  </div>
                  <StatusBadge status={r.status} />
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {r.code}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OwnerWorkspace() {
  const workspace = useQuery(api.admin.myRestaurantWorkspace, {});
  const hasRestaurant = workspace !== undefined && workspace !== null;

  const restaurant = workspace!.restaurant as unknown as RestaurantInfo;
  const stats = useQuery(
    api.reservations.adminStats,
    hasRestaurant ? { restaurantId: restaurant._id } : "skip",
  );
  const today = hasRestaurant ? todayInZone(restaurant.timezone) : "";
  const dayReservations = useQuery(
    api.reservations.restaurantDayReservations,
    hasRestaurant ? { restaurantId: restaurant._id, date: today } : "skip",
  );

  if (workspace === undefined) {
    return (
      <Card className="border-border/70 shadow-none">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Loading workspace…
        </CardContent>
      </Card>
    );
  }
  if (workspace === null) {
    return (
      <Card className="border-border/70 shadow-none">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No restaurant is linked to this account yet.
        </CardContent>
      </Card>
    );
  }

  const info = workspace!.restaurant as unknown as RestaurantInfo;
  const todayRows = (dayReservations ?? []).filter(
    (r: { status: string }) => r.status === "confirmed",
  );
  const dow = new Date().getDay();
  const hoursEntry = info.openingHours?.weekly?.find((h) => h.day === dow);

  return (
    <div className="space-y-6">
      <Card className="border-border/70 shadow-none">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Store className="size-5" />
            </div>
            <CardTitle>{info.name}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {info.cuisine} · {info.city} · {info.priceRange}
            </p>
          </div>
          <div className="flex gap-5 text-right">
            <div>
              <p className="text-2xl font-bold">{stats?.today ?? "–"}</p>
              <p className="text-xs text-muted-foreground">Today</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{stats?.upcoming ?? "–"}</p>
              <p className="text-xs text-muted-foreground">Upcoming</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{stats?.tables ?? "–"}</p>
              <p className="text-xs text-muted-foreground">Tables</p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {hoursEntry?.open ? formatWallTime(hoursEntry.open) : "Closed"} –{" "}
            {hoursEntry?.close ? formatWallTime(hoursEntry.close) : ""} today · Duration{" "}
            {info.reservationDurationMin} min · Slot step {info.slotStepMin} min
          </p>
        </CardContent>
      </Card>

      <Card className="border-border/70 shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Today's reservations · {today}</CardTitle>
        </CardHeader>
        <CardContent>
          {dayReservations === undefined ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : todayRows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No reservations today yet. New bookings appear here and in live activity.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {todayRows.map((r) => (
                <li key={r._id} className="flex items-center gap-4 py-3">
                  <div className="w-20 shrink-0 font-mono text-sm">
                    {formatWallTime(r.localTime)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.customerName}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.partySize} guests · Table {r.tableNumber}
                    </p>
                  </div>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {r.code}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ClaimOwnerCard() {
  const claimOwner = useMutation(api.demo.claimOwner);
  const [busy, setBusy] = useState(false);

  const claim = async () => {
    setBusy(true);
    try {
      await claimOwner({});
      toast.success("Restaurant linked — switching to the owner view");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not claim a restaurant");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-dashed border-border/70 shadow-none">
      <CardContent className="py-8 text-center">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Store className="size-5" />
        </div>
        <p className="font-medium">Run a restaurant?</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Claim a restaurant to unlock the owner dashboard: manage tables,
          hours and today's bookings.
        </p>
        <Button
          className="mt-4 cursor-pointer"
          disabled={busy}
          onClick={() => void claim()}
        >
          {busy ? "Claiming…" : "Claim a restaurant"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const workspace = useQuery(api.admin.myRestaurantWorkspace, {});
  const isOwner = workspace !== null && workspace !== undefined;
  const [tab, setTab] = useState<"reservations" | "restaurant">("reservations");

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">TableKeeper workspace</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">
              Welcome{user?.name ? `, ${user.name}` : ""}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {isOwner && (
              <div className="flex rounded-lg border border-border/70 p-1">
                <Button
                  variant={tab === "reservations" ? "secondary" : "ghost"}
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => setTab("reservations")}
                >
                  <CalendarDays className="mr-1.5 size-4" /> Reservations
                </Button>
                <Button
                  variant={tab === "restaurant" ? "secondary" : "ghost"}
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => setTab("restaurant")}
                >
                  <Store className="mr-1.5 size-4" /> Restaurant
                </Button>
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer gap-2"
              onClick={handleSignOut}
            >
              <LogOut className="size-4" />
              Sign out
            </Button>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-6">
            {isOwner && tab === "restaurant" ? (
              <OwnerWorkspace />
            ) : (
              <>
                <CustomerReservations />
                {!isOwner && workspace !== undefined && <ClaimOwnerCard />}
              </>
            )}
          </div>
          <LiveActivityCard />
        </div>
      </div>
    </main>
  );
}
