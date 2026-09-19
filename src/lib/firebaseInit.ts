/**
 * Firebase app initialization core (kept separate to avoid import cycles
 * between the config-query module and the imperative auth helpers).
 */
import { initializeApp, getApps, deleteApp, type FirebaseApp } from "firebase/app";

let app: FirebaseApp | null = null;

export function ensureAppFromConfig(cfg: {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
}): FirebaseApp {
  if (app) return app;
  const existing = getApps();
  if (existing.length > 0) {
    // Reuse the first app; if its options differ (e.g. keys just changed),
    // replace it so the new config takes effect.
    const a = existing[0];
    if (a.options.projectId === cfg.projectId) {
      app = a;
      return app;
    }
    void deleteApp(a);
  }
  app = initializeApp({
    apiKey: cfg.apiKey,
    authDomain: cfg.authDomain,
    databaseURL: cfg.databaseURL,
    projectId: cfg.projectId,
  });
  return app;
}

export function currentFirebaseApp(): FirebaseApp | null {
  return app;
}
