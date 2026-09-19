/**
 * Synchronous access to the Firebase app/auth instances.
 *
 * `getFirebaseAuth()` returns null until the public web config has been
 * fetched from the backend (see src/lib/firebase.ts which initializes the
 * app from the query result). All imperative auth calls go through here so
 * they never crash when Firebase is not yet configured.
 */
import { getAuth, type Auth } from "firebase/auth";
import type { FirebaseApp } from "firebase/app";
import { ensureAppFromConfig } from "./firebaseInit";

let app: FirebaseApp | null = null;

/** Track the config fingerprint this app was initialized with. */
let initializedFor: string | null = null;

export function initFirebaseFromConfig(cfg: {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
}): void {
  const fingerprint = `${cfg.projectId}:${cfg.apiKey}`;
  if (initializedFor === fingerprint) return;
  app = ensureAppFromConfig(cfg);
  initializedFor = fingerprint;
}

export function getFirebaseAuth(): Auth | null {
  return app ? getAuth(app) : null;
}
