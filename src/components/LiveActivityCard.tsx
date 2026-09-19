import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveActivity } from "@/hooks/use-live-activity";
import { formatWallTime } from "@/lib/tz";
import type { LiveEvent } from "@/convex/firebaseRtdb";
import {
  Activity,
  CheckCircle2,
  Clock,
  FlaskConical,
  PencilLine,
  RefreshCw,
  XCircle,
  Zap,
} from "lucide-react";

const RESULTS = ["confirmed", "cancelled", "modified"] as const;

function randomEvent(): LiveEvent {
  const result = RESULTS[Math.floor(Math.random() * RESULTS.length)];
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = pad(Math.max(17, Math.min(21, now.getHours() + Math.floor(Math.random() * 3))));
  return {
    id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    code: `TK-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
    result,
    tableNumber: 1 + Math.floor(Math.random() * 12),
    partySize: 1 + Math.floor(Math.random() * 6),
    localDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    localTime: `${h}:${["00", "30"][Math.floor(Math.random() * 2)]}`,
    at: Date.now(),
  };
}

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

export function LiveActivityCard() {
  const { loading, error, configured, reason, events, refresh } = useLiveActivity(true);
  const [demoEvents, setDemoEvents] = useState<LiveEvent[]>(() =>
    Array.from({ length: 3 }, randomEvent),
  );
  const demo = !configured;

  const simulate = () => {
    setDemoEvents((prev) => [randomEvent(), ...prev].slice(0, 8));
  };

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Zap className="size-5" />
          </div>
          <CardTitle className="flex items-center gap-2">
            Live activity
            <span
              className="relative flex size-2"
              title={demo ? "Demo preview — Firebase not configured" : "Streaming from Firebase Realtime Database"}
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Reservation events mirrored to Firebase Realtime Database
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          title="Refresh"
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        {demo ? (
          <>
            <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2.5">
              <FlaskConical className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div className="text-xs leading-relaxed">
                <p className="font-medium text-amber-600 dark:text-amber-400">Demo preview</p>
                <p className="mt-0.5 text-muted-foreground">
                  Firebase keys aren&apos;t configured yet, so simulated events are shown. Add{" "}
                  <code className="font-mono">FIREBASE_DATABASE_URL</code>,{" "}
                  <code className="font-mono">FIREBASE_CLIENT_EMAIL</code> and{" "}
                  <code className="font-mono">FIREBASE_PRIVATE_KEY</code> in the Keys tab to stream
                  real events here.
                </p>
              </div>
            </div>
            <ul className="divide-y divide-border/60">
              {demoEvents.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ul>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 w-full cursor-pointer gap-2"
              onClick={simulate}
            >
              <Zap className="size-4" /> Simulate event
            </Button>
          </>
        ) : loading ? (
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
        ) : error || reason === "error" ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Couldn&apos;t reach the realtime feed. It will retry automatically.
          </p>
        ) : reason === "forbidden" ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Live activity is available to restaurant admins.
          </p>
        ) : events.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No reservation activity yet. New bookings appear here in real time.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {events.slice(0, 8).map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
