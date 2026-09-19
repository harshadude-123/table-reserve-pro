/**
 * Firebase project configuration — server-side reader.
 *
 * Reads the Firebase keys from the deployment environment (Keys/API keys tab)
 * and derives the public web config the browser needs to initialize the
 * Firebase JS SDK, plus the service-account status for admin/RTDB access.
 *
 * IMPORTANT — no secrets ever leave the server. The web config consists of
 * public identifiers only (apiKey in a Firebase web config is a public
 * identifier by design; access is controlled by Firebase security rules and
 * authorized domains). The service-account private key, client email and
 * database URL are read ONLY inside "use node" actions on the server
 * (see firebaseRtdb.ts / lib/rtdbConfig.ts).
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  /** Service-account credentials present (RTDB mirror will work). */
  adminConfigured: boolean;
}

function envOf(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function adminConfigured(): boolean {
  if (envOf("FIREBASE_CLIENT_EMAIL") && envOf("FIREBASE_PRIVATE_KEY")) return true;
  const svc = envOf("FIREBASE_SERVICE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT_JSON");
  if (!svc) return false;
  try {
    const parsed = JSON.parse(svc) as Record<string, unknown>;
    return (
      typeof parsed.client_email === "string" && typeof parsed.private_key === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Derive the public web config. Accepts either the individual vars or a full
 * web-config JSON paste (the snippet Firebase shows in Project settings →
 * General → Your apps → SDK setup and configuration).
 */
export function readFirebaseWebConfig(): FirebaseWebConfig | null {
  const projectId = envOf("FIREBASE_PROJECT_ID");
  const apiKey = envOf("FIREBASE_API_KEY");
  const databaseURL = envOf("FIREBASE_DATABASE_URL");

  let parsedJson: Record<string, unknown> | null = null;
  const jsonRaw = envOf("FIREBASE_WEB_CONFIG", "FIREBASE_WEB_CONFIG_JSON");
  if (jsonRaw) {
    try {
      parsedJson = JSON.parse(jsonRaw) as Record<string, unknown>;
    } catch {
      parsedJson = null;
    }
  }

  const pId =
    projectId ??
    (typeof parsedJson?.projectId === "string" ? parsedJson.projectId : undefined);
  const key =
    apiKey ??
    (typeof parsedJson?.apiKey === "string" ? parsedJson.apiKey : undefined);
  const dbUrl =
    databaseURL ??
    (typeof parsedJson?.databaseURL === "string" ? parsedJson.databaseURL : undefined);
  const authDomainRaw =
    envOf("FIREBASE_AUTH_DOMAIN") ??
    (typeof parsedJson?.authDomain === "string" ? parsedJson.authDomain : undefined);

  if (!pId || !key || !dbUrl) return null;

  const authDomain = authDomainRaw ?? `${pId}.firebaseapp.com`;
  return {
    apiKey: key,
    authDomain,
    databaseURL: dbUrl.startsWith("http") ? dbUrl : `https://${dbUrl}`,
    projectId: pId,
    adminConfigured: adminConfigured(),
  };
}
