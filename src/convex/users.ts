import { query, QueryCtx, mutation } from "./_generated/server";
import { currentUserDoc, ensureFirebaseProfile } from "./firebaseIdentity";
import { readFirebaseWebConfig } from "./firebaseConfig";

/**
 * Get the current signed in user. Returns null if the user is not signed in.
 * Usage: const signedInUser = await ctx.runQuery(api.users.currentUser);
 * THIS FUNCTION IS READ-ONLY. DO NOT MODIFY.
 */
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);

    if (user === null) {
      return null;
    }

    return user;
  },
});

/**
 * Use this function internally to get the current user data. Remember to handle the null user case.
 * @param ctx
 * @returns
 */
export const getCurrentUser = async (ctx: QueryCtx) => {
  return await currentUserDoc(ctx);
};

/**
 * Public (no-secret) Firebase web config for the client SDK. The values are
 * public identifiers, NOT credentials — Firebase web apps are secured by
 * security rules + authorized domains, not by hiding these. Returns null
 * when the integration is not configured so the UI can fall back.
 */
export const firebaseWebConfig = query({
  args: {},
  handler: async () => {
    return readFirebaseWebConfig();
  },
});

/** Whether Firebase Auth is configured on the deployment. */
export const firebaseAuthEnabled = query({
  args: {},
  handler: async () => {
    return readFirebaseWebConfig() !== null;
  },
});

/**
 * Called by the client right after Firebase sign-in confirms: provisions the
 * Convex users document for the Firebase identity (idempotent). Sign-in via
 * the self-issued email-OTP provider needs no provisioning.
 */
export const ensureProfile = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await ensureFirebaseProfile(ctx);
    return { ok: userId !== null };
  },
});
