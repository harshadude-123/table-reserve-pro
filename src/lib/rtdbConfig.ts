/**
 * Firebase Realtime Database credential parsing — pure and unit-testable.
 *
 * Accepts either the three individual variables or a single full
 * service-account JSON key (convenient for key-paste UIs). Returns null when
 * the integration is not configured; callers treat that as "mirror disabled".
 *
 * Required env vars (Keys/API keys tab):
 *   FIREBASE_DATABASE_URL     e.g. https://<project>-default-rtdb.firebaseio.com
 *   FIREBASE_CLIENT_EMAIL     service-account email
 *   FIREBASE_PRIVATE_KEY      service-account private key
 *   FIREBASE_PROJECT_ID       (optional, informational)
 *   or a single FIREBASE_SERVICE_ACCOUNT containing the full JSON key file.
 */

export interface RtdbConfig {
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
