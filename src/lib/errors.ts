/**
 * Typed error codes for the reservation domain.
 *
 * Every failure mode of the booking system maps to one of these codes, so the
 * backend can return a stable machine-readable code AND a user-friendly
 * message. The frontend renders `message` and can special-case `code` for
 * things like refreshing stale availability.
 */

export const ReservationErrorCode = {
  /** Another customer reserved the overlapping slot first (HTTP 409). */
  TABLE_CONFLICT: "TABLE_CONFLICT",
  /** The same idempotency key is in-flight; original result will be returned. */
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  /** Requested slot is outside the restaurant's opening hours. */
  RESTAURANT_CLOSED: "RESTAURANT_CLOSED",
  /** Party size outside the allowed range for the restaurant. */
  INVALID_PARTY_SIZE: "INVALID_PARTY_SIZE",
  /** Unparseable / out-of-range date or time. */
  INVALID_DATE_TIME: "INVALID_DATE_TIME",
  /** Requested time is in the past (restaurant-local). */
  PAST_RESERVATION: "PAST_RESERVATION",
  /** Not enough notice for this restaurant's booking window. */
  BOOKING_WINDOW: "BOOKING_WINDOW",
  /** No table with capacity >= party size is free at that time. */
  NO_AVAILABILITY: "NO_AVAILABILITY",
  /** Target reservation does not exist. */
  NOT_FOUND: "NOT_FOUND",
  /** Authenticated user is not allowed to touch this reservation. */
  FORBIDDEN: "FORBIDDEN",
  /** Caller is not authenticated. */
  UNAUTHENTICATED: "UNAUTHENTICATED",
  /** Cancelled reservation cannot be cancelled again / modified. */
  ALREADY_CANCELLED: "ALREADY_CANCELLED",
  /** Payload failed validation. */
  VALIDATION: "VALIDATION",
  /** A different restaurant (for modify) or restaurant mismatch. */
  WRONG_RESTAURANT: "WRONG_RESTAURANT",
} as const;

export type ReservationErrorCode =
  (typeof ReservationErrorCode)[keyof typeof ReservationErrorCode];

export interface ReservationErrorShape {
  code: ReservationErrorCode;
  message: string;
  /** Suggested HTTP status for the REST surface. */
  httpStatus: number;
  /** Extra structured context (e.g. conflicting reservation id). */
  details?: Record<string, unknown>;
}

/**
 * Build a plain-serializable error payload. Convex mutations can only throw
 * strings, so services return `{ ok: false, error }` objects and the mutation
 * layer throws a JSON-encoded string that the HTTP layer (or a client wrapper)
 * decodes back into this shape.
 */
export function reservationError(
  code: ReservationErrorCode,
  message: string,
  httpStatus = 400,
  details?: Record<string, unknown>,
): ReservationErrorShape {
  return { code, message, httpStatus, ...(details ? { details } : {}) };
}

/** Encode an error payload into a string safe to throw across a Convex mutation. */
export function encodeReservationError(error: ReservationErrorShape): string {
  return `RESERVATION_ERROR:${JSON.stringify(error)}`;
}

/** Decode a thrown Convex error string back into a typed payload, or null. */
export function decodeReservationError(
  thrown: unknown,
): ReservationErrorShape | null {
  if (typeof thrown !== "string") return null;
  const prefix = "RESERVATION_ERROR:";
  if (!thrown.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(thrown.slice(prefix.length));
    if (parsed && typeof parsed.code === "string" && typeof parsed.message === "string") {
      return parsed as ReservationErrorShape;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Map a decoded error to a friendly, action-oriented toast message.
 * Codes that mean "availability went stale" suggest refreshing slots.
 */
export function friendlyErrorMessage(code: ReservationErrorCode): string {
  switch (code) {
    case ReservationErrorCode.TABLE_CONFLICT:
      return "Sorry — this table was just reserved by another customer. Please pick another time.";
    case ReservationErrorCode.IDEMPOTENCY_IN_PROGRESS:
      return "Your reservation request is already being processed. Hang tight!";
    case ReservationErrorCode.RESTAURANT_CLOSED:
      return "The restaurant is closed at that time. Please choose a time within opening hours.";
    case ReservationErrorCode.INVALID_PARTY_SIZE:
      return "Party size must be between 1 and 20 guests.";
    case ReservationErrorCode.INVALID_DATE_TIME:
      return "That date or time isn't valid. Please pick a different slot.";
    case ReservationErrorCode.PAST_RESERVATION:
      return "You can't book a table in the past. Choose an upcoming time.";
    case ReservationErrorCode.BOOKING_WINDOW:
      return "That booking is outside the restaurant's reservation window (too last-minute or too far out).";
    case ReservationErrorCode.NO_AVAILABILITY:
      return "No tables are available for that party size at that time. Try another slot.";
    case ReservationErrorCode.NOT_FOUND:
      return "We couldn't find that reservation.";
    case ReservationErrorCode.FORBIDDEN:
      return "You don't have access to this reservation.";
    case ReservationErrorCode.UNAUTHENTICATED:
      return "Please sign in to manage reservations.";
    case ReservationErrorCode.ALREADY_CANCELLED:
      return "This reservation is already cancelled.";
    case ReservationErrorCode.WRONG_RESTAURANT:
      return "This reservation belongs to a different restaurant.";
    case ReservationErrorCode.VALIDATION:
    default:
      return "Something went wrong. Please review your details and try again.";
  }
}

/** True when the error implies the client's slot data may be stale. */
export function isStaleAvailabilityError(code: ReservationErrorCode): boolean {
  return (
    code === ReservationErrorCode.TABLE_CONFLICT ||
    code === ReservationErrorCode.NO_AVAILABILITY
  );
}
