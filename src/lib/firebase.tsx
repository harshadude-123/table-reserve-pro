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
 * IMPORTANT ARCHITECTURE NOTE — why this module never uses Convex hooks in
 * `useFirebaseAuthBridge`:
 *
 *   <ConvexProviderWithAuth useAuth={useFirebaseAuthBridge}> calls the bridge
 *   hook BEFORE <ConvexProvider> renders, i.e. OUTSIDE the Convex context.
 *   Any useQuery/useMutation/useConvexAuth inside the bridge throws
 *   "Could not find Convex client!". So the bridge reads the config from a
 *   plain module store (below), and <FirebaseConfigBridge /> — a component
 *   mounted UNDER the provider in main.tsx — is the only place that runs the
 *   `users.firebaseWebConfig` query and publishes it into that store.
 */
import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
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

/* ------------------------------------------------------------------ */
/* Module-level config store                                           */
/*                                                                     */
/* undefined → query still loading; null → Firebase not configured;    */
/* object → ready. Read with useSyncExternalStore from hooks that run  */
/* OUTSIDE the Convex provider (the auth bridge); written only by      */
/* <FirebaseConfigBridge />, which lives INSIDE the provider tree.     */
/* ------------------------------------------------------------------ */

let sharedConfig: FirebaseWebConfigPublic | null | undefined = undefined;
const listeners = new Set<() => void>();

function publishFirebaseConfig(cfg: FirebaseWebConfigPublic | null): void {
  // Skip no-op updates so subscribers don't re-render unnecessarily
  // (StrictMode double-effects deliver the same query result twice).
  if (sharedConfig === cfg) return;
  if (sharedConfig && cfg && sharedConfig.projectId === cfg.projectId && sharedConfig.apiKey === cfg.apiKey) {
    // Same effective config: keep the existing reference so the
    // useSyncExternalStore snapshot stays stable (avoids re-render loops).
    return;
  }
  sharedConfig = cfg;
  for (const listener of listeners) listener();
}

function subscribeToFirebaseConfig(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Status of the backend-provided Firebase config. Safe to call anywhere in
 * the tree (no Convex hooks — it reads the module store).
 */
export function useFirebaseConfig() {
  const cfg = useSyncExternalStore(subscribeToFirebaseConfig, () => sharedConfig);
  return {
    /** undefined = still loading; null = not configured; object = ready. */
    config: cfg ?? null,
    loading: cfg === undefined,
    configured: cfg != null,
  };
}

/**
 * Renders nothing. MUST be mounted under <ConvexProviderWithAuth> — it runs
 * the public `users.firebaseWebConfig` query and publishes the result to the
 * module store consumed by the auth bridge. This is the only component that
 * bridges Convex data into the Firebase bootstrapping path.
 */
export function FirebaseConfigBridge() {
  return (
    <FirebaseConfigErrorBoundary>
      <FirebaseConfigBridgeInner />
    </FirebaseConfigErrorBoundary>
  );
}

function FirebaseConfigBridgeInner() {
  const cfg = useQuery(api.users.firebaseWebConfig);
  useEffect(() => {
    // undefined = query still loading; null = not configured.
    if (cfg !== undefined) publishFirebaseConfig(cfg as FirebaseWebConfigPublic | null);
  }, [cfg]);
  return null;
}

/**
 * `convex/react`'s useQuery THROWS query errors during render. A transient
 * backend hiccup (e.g. loading while a push is in flight, so the function is
 * briefly missing from the deployed bundle) would otherwise white-screen the
 * entire app from this root-level query. Instead: swallow the error, render
 * nothing (the store keeps reporting "loading"), and remount after a short
 * delay — Convex re-delivers the result once the deployment recovers.
 */
class FirebaseConfigErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: Error) {
    console.warn("[firebase] config query failed, retrying in 2.5s:", err.message);
  }

  componentDidMount() {
    this.scheduleRetryIfFailed();
  }

  componentDidUpdate() {
    this.scheduleRetryIfFailed();
  }

  componentWillUnmount() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private scheduleRetryIfFailed() {
    if (!this.state.failed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState({ failed: false });
    }, 2500);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Auth bridge hook passed to <ConvexProviderWithAuth useAuth={...}>.
 * Runs OUTSIDE the Convex provider — must not use Convex hooks.
 *
 * When Firebase is not configured it reports "signed out, loaded" so the UI
 * renders its not-configured state instead of hanging.
 */
export function useFirebaseAuthBridge(): {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: User | null;
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
} {
  const { config, configured } = useFirebaseConfig();

  const [user, setUser] = useState<User | null>(null);
  const [userResolved, setUserResolved] = useState(false);

  useEffect(() => {
    if (!configured || !config) {
      setUser(null);
      setUserResolved(true);
      return;
    }
    // Config just became available: initialize the Firebase app, then
    // subscribe to auth state. onAuthStateChanged fires immediately with the
    // current user (or null), which resolves `userResolved`.
    initFirebaseFromConfig(config);
    const app = currentFirebaseApp();
    if (!app) {
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
  }, [configured, config]);

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
