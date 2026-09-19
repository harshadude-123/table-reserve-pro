import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useFirebaseConfig } from "@/lib/firebase";
import { subscribeToActivity, type ActivitySubscriptionHandle } from "@/lib/rtdbClient";
import { formatWallTime } from "@/lib/tz";
import type { LiveEvent } from "@/convex/firebaseRtdb";
import {
  Activity,
  CheckCircle2,
  Clock,
  Database,
  PencilLine,
  Radio,
  ShieldCheck,
  XCircle,
  Zap,
} from "lucide-react";

function EventRow({ event }: { event: LiveEvent }) {
  const isConfirmed = event.result === "confirmed";
  const isCancelled = event.result === "cancelled";
  const isModified = event.result === "modified";

  const Icon = isConfirmed ? CheckCircle2 : isCancelled ? XCircle : isModified ? PencilLine : Activity;
  const tone = isConfirmed
    ? "text-emerald-500"
    : isCancelled
      ? "text-rose-500"
      : isModified
        ? "text-amber-500"
        : "text-muted-foreground";

  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className={`size-4 ${tone}`} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {isConfirmed && "Table reserved"}
          {isCancelled && "Reservation cancelled"}
          {isModified && "Reservation modified"}
          {!isConfirmed && !isCancelled && !isModified && (event.result ?? "Event")}
          {event.tableNumber ? (
            <span className="text-muted-foreground"> · Table {event.tableNumber}</span>
          ) : null}
          {event.partySize ? (
            <span className="text-muted-foreground"> · {event.partySize} guests</span>
          ) : null}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3" />
          {event.localDate ? event.localDate : ""}
          {event.localTime ? ` · ${formatWallTime(event.localTime)}` : ""}
        </p>
      </div>
      {event.code ? (
        <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
          {event.code}
        </Badge>
      ) : null}
    </li>
  );
}

/**
 * Live activity card — real Firebase Realtime Database data only.
 *
 * Subscribes to `activity/{restaurantId}` with onValue, so events appear
 * sub-second after the server-side mirror writes them. There are NO
 * simulated/demo events in production UI: when the integration is not
 * configured the card shows exactly what is needed to finish setup.
 */
export function LiveActivityCard() {
  const workspace = useQuery(api.admin.myRestaurantWorkspace, {});
  const { configured, loading: configLoading } = useFirebaseConfig();

  const restaurantId =
    workspace && workspace !== null
      ? ((workspace.restaurant as unknown as { _id: string })._id ?? null)
      : null;

  const [events, setEvents] = useState<LiveEvent[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setEvents(null);
    setError(false);
    if (!configured || !restaurantId) return;

    const handle: ActivitySubscriptionHandle | null = subscribeToActivity(
      restaurantId,
      (incoming) => {
        setEvents(incoming);
        setError(false);
      },
      () => setError(true),
      25,
    );
    if (!handle) {
      setError(true);
      return;
    }
    return handle.unsubscribe;
  }, [configured, restaurantId]);

  const loadingFeed = configured && restaurantId !== null && events === null && !error;

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Radio className="size-5" />
          </div>
          <CardTitle className="flex items-center gap-2">
            Live activity
            <span
              className={`relative flex size-2 ${configured && !error ? "" : "opacity-40"}`}
              title={
                configured
                  ? error
                    ? "Realtime connection error — retrying automatically"
                    : "Streaming from Firebase Realtime Database"
                  : "Firebase not configured"
              }
            >
              <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${configured && !error ? "animate-ping bg-emerald-400" : "bg-muted-foreground"}`} />
              <span className={`relative inline-flex size-2 rounded-full ${configured && !error ? "bg-emerald-500" : "bg-muted-foreground"}`} />
            </span>
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Reservation events streamed from Firebase Realtime Database
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {configLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Connecting…</p>
        ) : !configured ? (
          <div className="py-6 text-center">
            <Database className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-sm font-medium">Firebase not connected</p>
            <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
              Add the Firebase keys (project ID, web API key, database URL and
              service account) in the Keys tab to stream live reservations here.
            </p>
          </div>
        ) : !restaurantId ? (
          <div className="py-6 text-center">
            <ShieldCheck className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Live activity is available to restaurant admins once a restaurant
              is linked to this account.
            </p>
          </div>
        ) : error ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Couldn't reach the realtime feed. Retrying automatically…
          </p>
        ) : loadingFeed ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : (events?.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No reservation activity yet. New bookings appear here in real time.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {events!.slice(0, 8).map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
