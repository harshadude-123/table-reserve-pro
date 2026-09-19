/**
 * Client-side Realtime Database subscriptions.
 *
 * Live data paths (written by the server-side mirror in
 * src/convex/firebaseRtdb.ts):
 *
 *   activity/{restaurantId}              → chronological reservation events
 *   reservations/{restaurantId}/{resId}  → durable reservation documents
 *
 * Security model: the client subscribes with its Firebase Auth ID token
 * (firebase/auth token provider); Firebase security rules decide what each
 * signed-in identity may read. Suggested rules are documented in the README
 * section of the integration.
 */
import {
  getDatabase,
  ref,
  query as rtdbQuery,
  limitToLast,
  onValue,
  off,
  type Database,
} from "firebase/database";
import { currentFirebaseApp } from "./firebaseInit";
import type { LiveEvent } from "@/convex/firebaseRtdb";

function db(): Database | null {
  const app = currentFirebaseApp();
  return app ? getDatabase(app) : null;
}

export interface ActivitySubscriptionHandle {
  unsubscribe: () => void;
}

/**
 * Subscribe to the newest reservation events for a restaurant. Fires
 * immediately with current data and again on every server-side mirror
 * write (sub-second latency).
 */
export function subscribeToActivity(
  restaurantId: string,
  onUpdate: (events: LiveEvent[]) => void,
  onError: (err: Error) => void,
  limit = 25,
): ActivitySubscriptionHandle | null {
  const database = db();
  if (!database) return null;

  const eventsRef = rtdbQuery(
    ref(database, `activity/${restaurantId}`),
    limitToLast(limit),
  );

  const handler = onValue(
    eventsRef,
    (snapshot) => {
      const raw = (snapshot.val() ?? {}) as Record<string, Record<string, unknown>>;
      const events: LiveEvent[] = Object.entries(raw)
        .map(([id, e]) => ({
          id,
          code: typeof e.code === "string" ? e.code : null,
          result: typeof e.result === "string" ? e.result : null,
          tableNumber: typeof e.tableNumber === "number" ? e.tableNumber : null,
          partySize: typeof e.partySize === "number" ? e.partySize : null,
          localDate: typeof e.localDate === "string" ? e.localDate : null,
          localTime: typeof e.localTime === "string" ? e.localTime : null,
          at: typeof e.at === "number" ? e.at : null,
        }))
        .reverse(); // newest first
      onUpdate(events);
    },
    (err) => onError(err),
  );

  return {
    unsubscribe: () => {
      off(eventsRef, "value", handler);
    },
  };
}

/**
 * Map an RTDB reservation document into the dashboard's MyReservation shape
 * (fields overlap with the Convex query output so the UI is shared).
 */
export interface RtdbReservation {
  _id: string;
  code: string | null;
  status: string | null;
  partySize: number | null;
  startTimeUtc: number | null;
  endTimeUtc: number | null;
  localDate: string | null;
  localTime: string | null;
  localEndTime: string | null;
  tableNumber: number | null;
  restaurantName: string | null;
}
