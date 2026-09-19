/**
 * Targeted tests for the Firebase RTDB credential parser extracted to
 * src/lib/rtdbConfig.ts. Run with: bun test
 */
import { afterEach, describe, expect, test } from "bun:test";

import { readRtdbConfig } from "../src/lib/rtdbConfig";

const KEY = "-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n";
const KEY_REAL = KEY.replace(/\\n/g, "\n");

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ENV_KEYS = [
  "FIREBASE_DATABASE_URL",
  "VITE_FIREBASE_DATABASE_URL",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_SERVICE_ACCOUNT",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
];

afterEach(() => {
  // Never leak Firebase env into other tests.
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("readRtdbConfig", () => {
  test("returns null when nothing is configured", () => {
    withEnv(Object.fromEntries(ENV_KEYS.map((k) => [k, undefined])), () => {
      expect(readRtdbConfig()).toBeNull();
    });
  });

  test("returns null when the database URL is missing", () => {
    withEnv(
      {
        FIREBASE_DATABASE_URL: undefined,
        FIREBASE_CLIENT_EMAIL: "svc@test.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: KEY,
      },
      () => {
        expect(readRtdbConfig()).toBeNull();
      },
    );
  });

  test("returns null when credentials are missing", () => {
    withEnv(
      {
        FIREBASE_DATABASE_URL: "https://proj-default-rtdb.firebaseio.com",
        FIREBASE_CLIENT_EMAIL: undefined,
        FIREBASE_PRIVATE_KEY: undefined,
      },
      () => {
        expect(readRtdbConfig()).toBeNull();
      },
    );
  });

  test("parses individual vars and unescapes private-key newlines", () => {
    withEnv(
      {
        FIREBASE_DATABASE_URL: "https://proj-default-rtdb.firebaseio.com",
        FIREBASE_CLIENT_EMAIL: "svc@test.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: KEY,
        FIREBASE_PROJECT_ID: "proj",
      },
      () => {
        const cfg = readRtdbConfig();
        expect(cfg).not.toBeNull();
        expect(cfg!.databaseUrl).toBe("https://proj-default-rtdb.firebaseio.com");
        expect(cfg!.clientEmail).toBe("svc@test.iam.gserviceaccount.com");
        expect(cfg!.privateKey).toBe(KEY_REAL);
        expect(cfg!.projectId).toBe("proj");
      },
    );
  });

  test("accepts a URL without scheme and strips trailing slashes", () => {
    withEnv(
      {
        FIREBASE_DATABASE_URL: "proj-default-rtdb.firebaseio.com/",
        FIREBASE_CLIENT_EMAIL: "svc@test.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: KEY,
      },
      () => {
        const cfg = readRtdbConfig();
        expect(cfg!.databaseUrl).toBe("https://proj-default-rtdb.firebaseio.com");
      },
    );
  });

  test("parses a full service-account JSON (single paste)", () => {
    const svc = JSON.stringify({
      client_email: "svc@json.iam.gserviceaccount.com",
      private_key: KEY,
      project_id: "json-proj",
    });
    withEnv(
      {
        FIREBASE_DATABASE_URL: "https://json-proj-default-rtdb.firebaseio.com",
        FIREBASE_SERVICE_ACCOUNT: svc,
      },
      () => {
        const cfg = readRtdbConfig();
        expect(cfg).not.toBeNull();
        expect(cfg!.clientEmail).toBe("svc@json.iam.gserviceaccount.com");
        expect(cfg!.privateKey).toBe(KEY_REAL);
        expect(cfg!.projectId).toBe("json-proj");
      },
    );
  });

  test("individual vars win over the service-account JSON", () => {
    const svc = JSON.stringify({ client_email: "from@json", private_key: "json-key" });
    withEnv(
      {
        FIREBASE_DATABASE_URL: "https://x.firebaseio.com",
        FIREBASE_CLIENT_EMAIL: "explicit@test",
        FIREBASE_PRIVATE_KEY: KEY,
        FIREBASE_SERVICE_ACCOUNT: svc,
      },
      () => {
        const cfg = readRtdbConfig();
        expect(cfg!.clientEmail).toBe("explicit@test");
        expect(cfg!.privateKey).toBe(KEY_REAL);
      },
    );
  });

  test("malformed service-account JSON falls back to individual vars", () => {
    withEnv(
      {
        FIREBASE_DATABASE_URL: "https://x.firebaseio.com",
        FIREBASE_CLIENT_EMAIL: "svc@test",
        FIREBASE_PRIVATE_KEY: KEY,
        FIREBASE_SERVICE_ACCOUNT: "{not json",
      },
      () => {
        const cfg = readRtdbConfig();
        expect(cfg).not.toBeNull();
        expect(cfg!.clientEmail).toBe("svc@test");
      },
    );
  });
});
