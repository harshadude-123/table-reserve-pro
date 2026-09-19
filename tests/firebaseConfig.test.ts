/**
 * Targeted tests for the Firebase web-config reader (src/convex/firebaseConfig.ts)
 * — the pure env-parsing layer behind Firebase Auth sign-in. Run with: bun test
 */
import { afterEach, describe, expect, test } from "bun:test";

import { readFirebaseWebConfig } from "../src/convex/firebaseConfig";

const ENV_KEYS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_API_KEY",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_WEB_CONFIG",
  "FIREBASE_WEB_CONFIG_JSON",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_SERVICE_ACCOUNT",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
];

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
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

afterEach(() => {
  // Never leak Firebase env into other tests.
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("readFirebaseWebConfig", () => {
  test("returns null when nothing is configured", () => {
    withEnv(Object.fromEntries(ENV_KEYS.map((k) => [k, undefined])), () => {
      expect(readFirebaseWebConfig()).toBeNull();
    });
  });

  test("returns null when the API key is missing", () => {
    withEnv(
      {
        FIREBASE_PROJECT_ID: "tablekeeper",
        FIREBASE_API_KEY: undefined,
        FIREBASE_DATABASE_URL: "https://tablekeeper-default-rtdb.firebaseio.com",
      },
      () => {
        expect(readFirebaseWebConfig()).toBeNull();
      },
    );
  });

  test("returns null when the database URL is missing", () => {
    withEnv(
      {
        FIREBASE_PROJECT_ID: "tablekeeper",
        FIREBASE_API_KEY: "AIzaTestKey",
        FIREBASE_DATABASE_URL: undefined,
      },
      () => {
        expect(readFirebaseWebConfig()).toBeNull();
      },
    );
  });

  test("parses individual vars and derives the auth domain", () => {
    withEnv(
      {
        FIREBASE_PROJECT_ID: "tablekeeper",
        FIREBASE_API_KEY: "AIzaTestKey",
        FIREBASE_DATABASE_URL: "https://tablekeeper-default-rtdb.firebaseio.com",
      },
      () => {
        const cfg = readFirebaseWebConfig();
        expect(cfg).not.toBeNull();
        expect(cfg!.projectId).toBe("tablekeeper");
        expect(cfg!.apiKey).toBe("AIzaTestKey");
        expect(cfg!.databaseURL).toBe("https://tablekeeper-default-rtdb.firebaseio.com");
        expect(cfg!.authDomain).toBe("tablekeeper.firebaseapp.com");
        expect(cfg!.adminConfigured).toBe(false);
      },
    );
  });

  test("an explicit FIREBASE_AUTH_DOMAIN wins over the derived one", () => {
    withEnv(
      {
        FIREBASE_PROJECT_ID: "tablekeeper",
        FIREBASE_API_KEY: "AIzaTestKey",
        FIREBASE_DATABASE_URL: "https://tablekeeper-default-rtdb.firebaseio.com",
        FIREBASE_AUTH_DOMAIN: "auth.custom-domain.com",
      },
      () => {
        expect(readFirebaseWebConfig()!.authDomain).toBe("auth.custom-domain.com");
      },
    );
  });

  test("parses a full web-config JSON paste (single value)", () => {
    const webConfig = JSON.stringify({
      apiKey: "AIzaJsonKey",
      authDomain: "tablekeeper.firebaseapp.com",
      databaseURL: "https://tablekeeper-default-rtdb.firebaseio.com",
      projectId: "tablekeeper",
    });
    withEnv({ FIREBASE_WEB_CONFIG: webConfig }, () => {
      const cfg = readFirebaseWebConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.projectId).toBe("tablekeeper");
      expect(cfg!.apiKey).toBe("AIzaJsonKey");
      expect(cfg!.authDomain).toBe("tablekeeper.firebaseapp.com");
    });
  });

  test("individual vars win over the web-config JSON", () => {
    const webConfig = JSON.stringify({
      apiKey: "from-json",
      authDomain: "json.firebaseapp.com",
      databaseURL: "https://json-default-rtdb.firebaseio.com",
      projectId: "json-proj",
    });
    withEnv(
      {
        FIREBASE_WEB_CONFIG: webConfig,
        FIREBASE_PROJECT_ID: "explicit-proj",
        FIREBASE_API_KEY: "explicit-key",
        FIREBASE_DATABASE_URL: "https://explicit-default-rtdb.firebaseio.com",
      },
      () => {
        const cfg = readFirebaseWebConfig();
        expect(cfg!.projectId).toBe("explicit-proj");
        expect(cfg!.apiKey).toBe("explicit-key");
        expect(cfg!.databaseURL).toBe("https://explicit-default-rtdb.firebaseio.com");
      },
    );
  });

  test("scheme-less database URLs get the https prefix", () => {
    withEnv(
      {
        FIREBASE_PROJECT_ID: "tablekeeper",
        FIREBASE_API_KEY: "AIzaTestKey",
        FIREBASE_DATABASE_URL: "tablekeeper-default-rtdb.firebaseio.com",
      },
      () => {
        expect(readFirebaseWebConfig()!.databaseURL).toBe(
          "https://tablekeeper-default-rtdb.firebaseio.com",
        );
      },
    );
  });

  test("adminConfigured is true with service-account email + key", () => {
    withEnv(
      {
        FIREBASE_PROJECT_ID: "tablekeeper",
        FIREBASE_API_KEY: "AIzaTestKey",
        FIREBASE_DATABASE_URL: "https://tablekeeper-default-rtdb.firebaseio.com",
        FIREBASE_CLIENT_EMAIL: "svc@tablekeeper.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n",
      },
      () => {
        expect(readFirebaseWebConfig()!.adminConfigured).toBe(true);
      },
    );
  });

  test("adminConfigured is true from a service-account JSON paste", () => {
    const svc = JSON.stringify({
      client_email: "svc@json.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n",
      project_id: "json-proj",
    });
    withEnv(
      {
        FIREBASE_PROJECT_ID: "tablekeeper",
        FIREBASE_API_KEY: "AIzaTestKey",
        FIREBASE_DATABASE_URL: "https://tablekeeper-default-rtdb.firebaseio.com",
        FIREBASE_SERVICE_ACCOUNT: svc,
      },
      () => {
        expect(readFirebaseWebConfig()!.adminConfigured).toBe(true);
      },
    );
  });

  test("malformed service-account JSON does not throw and leaves adminConfigured false", () => {
    withEnv(
      {
        FIREBASE_PROJECT_ID: "tablekeeper",
        FIREBASE_API_KEY: "AIzaTestKey",
        FIREBASE_DATABASE_URL: "https://tablekeeper-default-rtdb.firebaseio.com",
        FIREBASE_SERVICE_ACCOUNT: "{not json",
      },
      () => {
        expect(() => readFirebaseWebConfig()).not.toThrow();
        expect(readFirebaseWebConfig()!.adminConfigured).toBe(false);
      },
    );
  });

  test("adminConfigured stays false when only one service-account field exists", () => {
    withEnv(
      {
        FIREBASE_PROJECT_ID: "tablekeeper",
        FIREBASE_API_KEY: "AIzaTestKey",
        FIREBASE_DATABASE_URL: "https://tablekeeper-default-rtdb.firebaseio.com",
        FIREBASE_CLIENT_EMAIL: "svc@tablekeeper.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: undefined,
      },
      () => {
        expect(readFirebaseWebConfig()!.adminConfigured).toBe(false);
      },
    );
  });
});
