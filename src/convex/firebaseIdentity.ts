/**
 * Firebase Authentication → Convex users mapping.
 *
 * Convex's own `getAuthUserId` assumes the JWT subject is a Convex `users`
 * document id (optionally "<userId>.<sessionId>" for self-issued sessions).
 * Firebase ID tokens instead carry the Firebase UID as `sub` and
 * `https://securetoken.google.com/<projectId>` as `iss`.
 *
 * This module resolves any authenticated identity to a real `users` document:
 *
 *   1. Firebase issuer → look up by `firebaseUid`. `resolveUserId` is
 *      read-only (usable from queries); `ensureFirebaseProfile` is the
 *      mutation that provisions the profile on first sign-in (the client
 *      calls `users.ensureProfile` right after auth state confirms).
 *   2. Anything else (self-issued email-OTP sessions) → the subject *is* the
 *      users doc id, so it is returned as-is.
 *
 * All reservation/admin code calls `resolveUserId` instead of
 * `getAuthUserId`, so both sign-in methods work everywhere.
 */

import { QueryCtx, MutationCtx, internalQuery } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

interface AnyIdentity {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  givenName?: string;
}

/** True when the identity was issued by Firebase Authentication. */
function isFirebaseIdentity(identity: AnyIdentity): boolean {
  return identity.issuer.startsWith("https://securetoken.google.com/");
}

/** Self-issued Convex Auth sessions encode the users doc id in the subject. */
function subjectAsUserId(identity: AnyIdentity): Id<"users"> {
  const [maybeUserId] = identity.subject.split(".");
  return maybeUserId as Id<"users">;
}

/**
 * Read-only resolution of the current identity to a users document id.
 * Returns null when unauthenticated OR when a Firebase user has not yet been
 * provisioned (the client calls `users.ensureProfile` right after sign-in).
 */
export async function resolveUserId(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users"> | null> {
  const identity = (await ctx.auth.getUserIdentity()) as AnyIdentity | null;
  if (identity === null) return null;

  if (isFirebaseIdentity(identity)) {
    const existing = await ctx.db
      .query("users")
      .withIndex("firebaseUid", (q) => q.eq("firebaseUid", identity.subject))
      .unique();
    return existing?._id ?? null;
  }

  return subjectAsUserId(identity);
}

/**
 * Mutation-side provisioning: resolves the identity and creates the users
 * document for a first-time Firebase sign-in using the verified email/name
 * claims from the ID token. Idempotent.
 */
export async function ensureFirebaseProfile(
  ctx: MutationCtx,
): Promise<Id<"users"> | null> {
  const identity = (await ctx.auth.getUserIdentity()) as AnyIdentity | null;
  if (identity === null) return null;

  if (!isFirebaseIdentity(identity)) {
    return subjectAsUserId(identity);
  }

  const uid = identity.subject;
  const existing = await ctx.db
    .query("users")
    .withIndex("firebaseUid", (q) => q.eq("firebaseUid", uid))
    .unique();
  if (existing) return existing._id;

  const email = identity.email ? identity.email : `${uid}@firebase.local`;
  const name = identity.name ?? identity.givenName ?? (identity.email ? identity.email.split("@")[0] : "Firebase user");
  return ctx.db.insert("users", {
    firebaseUid: uid,
    email,
    name,
  });
}

/**
 * Internal query wrapper so *actions* (which have no `db` handle) can resolve
 * the current identity to a users id: ctx.runQuery(internal.firebaseIdentity.currentUserId).
 */
export const currentUserId = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const userId = await resolveUserId(ctx);
    return userId as string | null;
  },
});

/** Current user document (or null), resolving Firebase identities. */
export async function currentUserDoc(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users"> | null> {
  const userId = await resolveUserId(ctx);
  if (userId === null) return null;
  return ctx.db.get(userId);
}
