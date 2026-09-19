"use node";

/**
 * Firebase Realtime Database — live reservation event mirror.
 *
 * Convex stays the transactional source of truth: the serializable
 * reserve/cancel/modify mutations own the no-double-booking guarantee. After
 * a transaction commits, it schedules `mirrorReservationEvent`, which writes
 * the event to Firebase RTDB:
 *
 *   activity/{restaurantId}/{pushId}   → chronological event feed
 *   stats/{restaurantId}               → latest event summary (dashboard tile)
 *
 * Because RTDB push IDs sort chronologically, the dashboard reads the last N
 * entries with `orderBy="$key"` and gets a live activity feed with sub-second
 * fan-out to any other RTDB-connected client.
 *
 * Auth: Google service-account JWT (RS256) exchanged for an OAuth2 access
 * token with the Firebase Database scopes — the RTDB REST `?auth=` token.
 *
 * Required env vars (Keys/API keys tab):
 *   FIREBASE_DATABASE_URL     e.g. https://<project>-default-rtdb.firebaseio.com
 *   FIREBASE_CLIENT_EMAIL     service-account email
 *   FIREBASE_PRIVATE_KEY      service-account private key
 *   FIREBASE_PROJECT_ID       (optional, informational)
 *   or a single FIREBASE_SERVICE_ACCOUNT containing the full JSON key file.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { JWT } from "google-auth-library";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

interface RtdbConfig {
  databaseUrl: string;
  clientEmail: string;
  privateKey: string;
  projectId: string;
}

function envOf(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

export function readRtdbConfig(): RtdbConfig | null {
  const databaseUrlRaw = envOf("FIREBASE_DATABASE_URL", "VITE_FIREBASE_DATABASE_URL");
  if (!databaseUrlRaw) return null;

  let clientEmail = envOf("FIREBASE_CLIENT_EMAIL");
  let privateKey = envOf("FIREBASE_PRIVATE_KEY");
  let projectId = envOf("FIREBASE_PROJECT_ID");

  // A single full service-account JSON also works (convenient for key paste).
  const svcJson = envOf("FIREBASE_SERVICE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT_JSON");
  if (svcJson && (!clientEmail || !privateKey)) {
    try {
      const parsed = JSON.parse(svcJson) as Record<string, unknown>;
      clientEmail ??= typeof parsed.client_email === "string" ? parsed.client_email : undefined;
      privateKey ??= typeof parsed.private_key === "string" ? parsed.private_key : undefined;
      projectId ??= typeof parsed.project_id === "string" ? parsed.project_id : undefined;
    } catch {
      // fall through to the individual variables
    }
  }
  if (!clientEmail || !privateKey) return null;

  // Keys pasted into a UI often arrive with escaped newlines.
  if (privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");

  const databaseUrl = `${databaseUrlRaw.startsWith("http") ? "" : "https://"}${databaseUrlRaw}`.replace(/\/+$/, "");
  return { databaseUrl, clientEmail, privateKey, projectId: projectId ?? "" };
}

/* ------------------------------------------------------------------ */
/* Auth token (cached best-effort per action isolate)                  */
/* ------------------------------------------------------------------ */

const FIREBASE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/firebase.database",
];

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(cfg: RtdbConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;

  const client = new JWT({ email: cfg.clientEmail, key: cfg.privateKey, scopes: FIREBASE_SCOPES });
  const credentials = await client.authorize();
  const token = credentials.access_token;
  if (!token) throw new Error("Google OAuth2 token exchange returned no access token.");

  cachedToken = {
    token,
    expiresAt: typeof credentials.expiry_date === "number" ? credentials.expiry_date : now + 55 * 60_000,
  };
  return token;
}

/* ------------------------------------------------------------------ */
/* RTDB REST helpers                                                   */
/* ------------------------------------------------------------------ */

function rtdbUrl(cfg: RtdbConfig, path: string): URL {
  return new URL(`${cfg.databaseUrl}/${path.replace(/^\/+/, "")}.json`);
}

/* ------------------------------------------------------------------ */
/* Types shared with the client                                        */
/* ------------------------------------------------------------------ */

export interface LiveEvent {
  id: string;
  code: string | null;
  result: string | null;
  tableNumber: number | null;
  partySize: number | null;
  localDate: string | null;
  localTime: string | null;
  at: number | null;
}

export interface LiveFeedResult {
  configured: boolean;
  restaurantId: string | null;
  reason: string | null;
  events: LiveEvent[];
}

export interface MirrorResult {
  mirrored: boolean;
  reason: string | null;
  pushId: string | null;
}

/* ------------------------------------------------------------------ */
/* Mirror: called (scheduled) by the reservation mutations             */
/* ------------------------------------------------------------------ */

export const mirrorReservationEvent = internalAction({
  args: {
    restaurantId: v.string(),
    reservationId: v.union(v.string(), v.null()),
    code: v.union(v.string(), v.null()),
    result: v.string(), // "confirmed" | "cancelled" | "modified" | "conflict"
    tableNumber: v.number(),
    partySize: v.number(),
    localDate: v.string(),
    localTime: v.string(),
    startUtc: v.number(),
    endUtc: v.number(),
    requestId: v.union(v.string(), v.null()),
  },
  handler: async (_ctx, event): Promise<MirrorResult> => {
    const cfg = readRtdbConfig();
    if (!cfg) return { mirrored: false, reason: "not_configured", pushId: null };

    try {
      const token = await getAccessToken(cfg);
      const now = Date.now();
      const payload = {
        reservationId: event.reservationId,
        code: event.code,
        result: event.result,
        tableNumber: event.tableNumber,
        partySize: event.partySize,
        localDate: event.localDate,
        localTime: event.localTime,
        startUtc: event.startUtc,
        endUtc: event.endUtc,
        requestId: event.requestId,
        at: now,
      };

      // Push into the restaurant's chronological feed (RTDB push IDs sort).
      const pushUrl = rtdbUrl(cfg, `activity/${event.restaurantId}`);
      pushUrl.searchParams.set("auth", token);
      const pushRes = await fetch(pushUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!pushRes.ok) {
        throw new Error(`RTDB push failed (${pushRes.status}): ${await pushRes.text().catch(() => "")}`);
      }
      const pushBody = (await pushRes.json().catch(() => ({}))) as { name?: string };

      // Latest-event summary tile.
      const statsUrl = rtdbUrl(cfg, `stats/${event.restaurantId}`);
      statsUrl.searchParams.set("auth", token);
      await fetch(statsUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastEventAt: now, lastResult: event.result, lastCode: event.code }),
      });

      return { mirrored: true, reason: null, pushId: pushBody.name ?? null };
    } catch (e) {
      // Mirroring is best-effort telemetry: never surface as a booking error.
      console.error("[firebase-rtdb] mirror failed:", e);
      return { mirrored: false, reason: "error", pushId: null };
    }
  },
});

/* ------------------------------------------------------------------ */
/* Live feed: polled by the admin dashboard                            */
/* ------------------------------------------------------------------ */

export const readLiveFeed = action({
  args: { restaurantId: v.optional(v.id("restaurants")), limit: v.optional(v.number()) },
  handler: async (ctx, { restaurantId, limit = 25 }): Promise<LiveFeedResult> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { configured: false, restaurantId: null, reason: "unauthenticated", events: [] };
    }

    const rid = restaurantId ?? (await ctx.runQuery(internal.rtdbHelpers.resolveAdminRestaurant, { userId }));
    if (!rid) {
      return { configured: true, restaurantId: null, reason: "no_restaurant", events: [] };
    }

    const isAdmin = await ctx.runQuery(internal.rtdbHelpers.adminRestaurantCheck, { userId, restaurantId: rid });
    if (!isAdmin) {
      return { configured: true, restaurantId: rid, reason: "forbidden", events: [] };
    }

    const cfg = readRtdbConfig();
    if (!cfg) {
      return { configured: false, restaurantId: rid, reason: "not_configured", events: [] };
    }

    try {
      const token = await getAccessToken(cfg);
      const url = rtdbUrl(cfg, `activity/${rid}`);
      url.searchParams.set("auth", token);
      url.searchParams.set("orderBy", '"$key"');
      url.searchParams.set("limitToLast", String(Math.min(Math.max(limit, 1), 50)));
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        throw new Error(`RTDB read failed (${res.status}): ${await res.text().catch(() => "")}`);
      }
      const data = (await res.json().catch(() => null)) as Record<string, Record<string, unknown>> | null;

      // Newest first. Normalize fields explicitly — Convex return values
      // cannot contain undefined, and no PII leaves the server.
      const events: LiveEvent[] = Object.entries(data ?? {})
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
        .reverse();

      return { configured: true, restaurantId: rid, reason: null, events };
    } catch (e) {
      console.error("[firebase-rtdb] readLiveFeed failed:", e);
      return { configured: true, restaurantId: rid, reason: "error", events: [] };
    }
  },
});
