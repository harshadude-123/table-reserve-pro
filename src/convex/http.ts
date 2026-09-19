import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { auth } from "./auth";
import { decodeReservationError } from "../lib/errors";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function withErrorMapping(e: unknown): Response {
  const decoded = decodeReservationError(e instanceof Error ? e.message : String(e));
  if (decoded) {
    return json(decoded.httpStatus, { error: decoded });
  }
  const message = e instanceof Error ? e.message : "Internal error";
  const isUnauth = /unauthenticated|sign in/i.test(message);
  return json(isUnauth ? 401 : 500, { error: { code: "INTERNAL", message } });
}

const http = httpRouter();

auth.addHttpRoutes(http);

/** OPTIONS preflight for all API routes. */
const preflight = httpAction(async () => new Response(null, { status: 204, headers: corsHeaders }));

/**
 * POST /api/reservations — atomic, idempotent reservation.
 * Body: { restaurantId, date (YYYY-MM-DD, restaurant-local), time (HH:MM),
 * partySize }. Idempotency-Key header or body.idempotencyKey supported.
 *
 * Convex Auth verifies the caller via the httpAction auth context (the
 * `Authorization: Bearer <Convex Auth token>` header); the mutation resolves
 * the user itself via getAuthUserId inside the transaction.
 */
const createReservationHttp = httpAction(async (ctx, request) => {
  try {
    const body = await request.json();
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? body?.idempotencyKey ?? undefined;
    const { restaurantId, date, time, partySize, tableId } = body ?? {};
    if (typeof restaurantId !== "string" || typeof date !== "string" || typeof time !== "string") {
      return json(400, { error: { code: "VALIDATION", message: "restaurantId, date and time are required." } });
    }
    const result = await ctx.runMutation(api.reservations.reserveAtomic, {
      restaurantId: restaurantId as any,
      date,
      time,
      partySize: Number(partySize) || 2,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(typeof tableId === "string" ? { tableId: tableId as any } : {}),
    });
    return json(201, result);
  } catch (e) {
    return withErrorMapping(e);
  }
});

/** GET /api/reservations/:id */
const getReservationHttp = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const id = url.pathname.split("/").filter(Boolean).pop() as string;
    const result = await ctx.runQuery(api.reservations.getReservation, { reservationId: id as any });
    return json(200, result);
  } catch (e) {
    return withErrorMapping(e);
  }
});

/** GET /api/restaurants/:id/availability?date=YYYY-MM-DD&partySize=2 */
const getAvailabilityHttp = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const restaurantId = parts[2];
    const date = url.searchParams.get("date") ?? "";
    const partySize = Number(url.searchParams.get("partySize") ?? "2");
    const result = await ctx.runQuery(api.reservations.getDayAvailability, {
      restaurantId: restaurantId as any,
      date,
      partySize,
    });
    return json(200, result);
  } catch (e) {
    return withErrorMapping(e);
  }
});

/** GET /api/users/me/reservations */
const listMyReservationsHttp = httpAction(async (ctx) => {
  try {
    const result = await ctx.runQuery(api.reservations.listMyReservations, {});
    return json(200, result);
  } catch (e) {
    return withErrorMapping(e);
  }
});

/** PATCH /api/reservations/:id */
const modifyReservationHttp = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const id = url.pathname.split("/").filter(Boolean).pop() as string;
    const body = await request.json();
    const result = await ctx.runMutation(api.reservations.modifyReservation, {
      reservationId: id as any,
      date: String(body?.date ?? ""),
      time: String(body?.time ?? ""),
      partySize: Number(body?.partySize ?? 2),
    });
    return json(200, result);
  } catch (e) {
    return withErrorMapping(e);
  }
});

/** DELETE /api/reservations/:id */
const cancelReservationHttp = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const id = url.pathname.split("/").filter(Boolean).pop() as string;
    const result = await ctx.runMutation(api.reservations.cancelReservation, { reservationId: id as any });
    return json(200, result);
  } catch (e) {
    return withErrorMapping(e);
  }
});

http.route({ pathPrefix: "/api/", method: "OPTIONS", handler: preflight });
http.route({ path: "/api/reservations", method: "POST", handler: createReservationHttp });
http.route({ path: "/api/users/me/reservations", method: "GET", handler: listMyReservationsHttp });
http.route({ pathPrefix: "/api/reservations/", method: "GET", handler: getReservationHttp });
http.route({ pathPrefix: "/api/restaurants/", method: "GET", handler: getAvailabilityHttp });
http.route({ pathPrefix: "/api/reservations/", method: "PATCH", handler: modifyReservationHttp });
http.route({ pathPrefix: "/api/reservations/", method: "DELETE", handler: cancelReservationHttp });

export default http;
