import { api } from "@/convex/_generated/api";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef } from "react";
import {
  createUserWithEmailAndPassword,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseApp";
import { useFirebaseAuthBridge } from "@/lib/firebase";

/**
 * Unified auth hook.
 *
 * Sign-in is Firebase Authentication (email + password, or anonymous guest).
 * The Firebase ID token is bridged into Convex via ConvexProviderWithAuth,
 * and the first sign-in provisions a matching Convex users document
 * (`users.ensureProfile`), so all reservation queries/mutations resolve the
 * user regardless of provider.
 */
export function useAuth() {
  const { isLoading: convexLoading, isAuthenticated } = useConvexAuth();
  const bridge = useFirebaseAuthBridge();
  const user = useQuery(api.users.currentUser);
  const ensureProfile = useMutation(api.users.ensureProfile);

  const ensureTriedFor = useRef<string | null>(null);

  // After the Convex socket confirms the Firebase token, provision the users
  // document once per Firebase uid (idempotent server-side).
  useEffect(() => {
    const uid = bridge.user?.uid ?? null;
    if (isAuthenticated && uid && ensureTriedFor.current !== uid) {
      ensureTriedFor.current = uid;
      void ensureProfile({}).catch((e) => {
        console.error("[auth] profile provisioning failed:", e);
        ensureTriedFor.current = null;
      });
    }
  }, [isAuthenticated, bridge.user, ensureProfile]);

  const isLoading = convexLoading || bridge.isLoading || (bridge.user !== null && user === undefined);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const auth = getFirebaseAuth();
      if (auth) return signInWithEmailAndPassword(auth, email, password);
      throw new Error(
        "Firebase is not configured yet. Add the Firebase keys in the Keys tab to enable sign-in.",
      );
    },
    [],
  );

  const signUp = useCallback(async (email: string, password: string) => {
    const auth = getFirebaseAuth();
    if (auth) return createUserWithEmailAndPassword(auth, email, password);
    throw new Error(
      "Firebase is not configured yet. Add the Firebase keys in the Keys tab to enable sign-up.",
    );
  }, []);

  const signInAsGuest = useCallback(async () => {
    const auth = getFirebaseAuth();
    if (auth) return signInAnonymously(auth);
    throw new Error(
      "Firebase is not configured yet. Add the Firebase keys in the Keys tab to enable guest sign-in.",
    );
  }, []);

  const signOut = useCallback(async () => {
    const auth = getFirebaseAuth();
    if (auth) await firebaseSignOut(auth);
  }, []);

  return {
    isLoading,
    isAuthenticated,
    user,
    firebaseUser: bridge.user,
    signIn,
    signUp,
    signInAsGuest,
    signOut,
  };
}
