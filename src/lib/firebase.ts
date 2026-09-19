/**
 * Client-side Firebase (Auth + Realtime Database).
 *
 * The web config (apiKey, authDomain, databaseURL, projectId) is fetched from
 * the Convex backend (`users.firebaseWebConfig`), which reads it from the
 * deployment's Keys/API keys environment. These are PUBLIC identifiers — the
 * same values Firebase itself ships in every web app's client bundle. No
 * secrets (service-account key, client email) ever reach the browser; those
 * stay server-side in `src/lib/rtdbConfig.ts`.
 *
 * Exposes a hook matching ConvexProviderWithAuth's expected shape:
 *   { isLoading, isAuthenticated, fetchAccessToken }
 */
import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  getAuth,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { ensureAppFromConfig, currentFirebaseApp } from "./firebaseInit";
import { initFirebaseFromConfig } from "./firebaseApp";

/** Public web config shape served by `users.firebaseWebConfig`. */
export interface FirebaseWebConfigPublic {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  adminConfigured: boolean;
}

/** Low-level status of the backend-provided Firebase config. */
export function useFirebaseConfig() {
  const cfg = useQuery(api.users.firebaseWebConfig);
  if (cfg) {
    // Initialize the app as soon as config arrives.
    initFirebaseFromConfig(cfg);
  }
  return {
    /** undefined = still loading; null = not configured; object = ready. */
    config: (cfg as FirebaseWebConfigPublic | null) ?? null,
    loading: cfg === undefined,
    configured: !!cfg,
  };
}

/**
 * Auth bridge hook passed to <ConvexProviderWithAuth useAuth={...}>.
 * When Firebase is not configured it reports "signed out, loaded" so the UI
 * renders its not-configured state instead of hanging.
 */
export function useFirebaseAuthBridge(): {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: User | null;
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
} {
  const { configured } = useFirebaseConfig();

  const [user, setUser] = useState<User | null>(null);
  const [userResolved, setUserResolved] = useState(false);

  useEffect(() => {
    const app = currentFirebaseApp();
    if (!configured || !app) {
      setUser(null);
      setUserResolved(true);
      return;
    }
    const auth = getAuth(app);
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setUserResolved(true);
    });
    return unsub;
  }, [configured]);

  const isLoading = !userResolved;

  const fetchAccessToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    const app = currentFirebaseApp();
    const auth = app ? getAuth(app) : null;
    if (!auth || !auth.currentUser) return null;
    try {
      return await auth.currentUser.getIdToken(forceRefreshToken);
    } catch {
      return null;
    }
  };

  return {
    isLoading,
    isAuthenticated: !!user,
    user,
    fetchAccessToken,
  };
}

export { ensureAppFromConfig };
