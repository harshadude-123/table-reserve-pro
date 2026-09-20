import type { AuthConfig } from "convex/server";

// Freebuff-signed federated tokens (see freebuff web's
// src/lib/vly-convex-jwt.ts) let a signed-in freebuff.com user carry their
// identity into this project without going through local sign-in. customJwt
// is correct for this provider: freebuff's tokens and JWKS both carry a
// `kid` header, which the customJwt validation path requires.
const freebuffIssuer =
  process.env.VLY_CONVEX_AUTH_ISSUER ?? "https://freebuff.com";

// Firebase Authentication issues RS256 ID tokens with a `kid` header and
// stable OIDC claims:
//   iss: https://securetoken.google.com/<projectId>
//   aud: <projectId>
// JWKS are served from googleapis (kid-keyed). This makes Firebase ID tokens
// a perfect fit for Convex's customJwt validation path: the client passes the
// ID token from Firebase Auth SDK (see src/lib/firebase.tsx +
// useFirebaseAuthBridge), and the backend verifies it against Google's JWKS.
//
// NOTE: the projectId must match the aud claim exactly. It comes from the
// FIREBASE_PROJECT_ID key. The value is set in the Keys/API keys tab; the
// fallback below is replaced by the real project id once the key exists.
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID ?? "";
const firebaseIssuer = firebaseProjectId
  ? `https://securetoken.google.com/${firebaseProjectId}`
  : "";

export default {
  providers: [
    // Standard Convex Auth provider for this project's own sign-in (email
    // OTP fallback, see src/convex/auth.ts). The deployment self-issues JWTs
    // (iss = CONVEX_SITE_URL, no `kid` header) validated via OIDC discovery
    // at `${domain}/.well-known/openid-configuration`, served by
    // auth.addHttpRoutes() in convex/http.ts. Do NOT convert this entry to
    // `type: "customJwt"` — that path rejects tokens without a `kid` header,
    // so sign-in would silently never confirm and RequireAuth would loop
    // back to /auth forever.
    {
      domain: process.env.CONVEX_SITE_URL!,
      applicationID: "convex",
    },
    {
      type: "customJwt",
      issuer: freebuffIssuer,
      jwks: `${freebuffIssuer}/api/web/.well-known/jwks.json`,
      applicationID: "vly-convex",
      algorithm: "RS256",
    },
    // Firebase Authentication — only registered when FIREBASE_PROJECT_ID is
    // configured, so existing deployments keep working without Firebase keys.
    ...(firebaseProjectId
      ? [
          {
            type: "customJwt" as const,
            issuer: firebaseIssuer,
            jwks: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
            applicationID: firebaseProjectId,
            algorithm: "RS256" as const,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
