import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
} from "jose";

export class OAuthAuthenticationError extends Error {
  constructor(message = "Invalid access token.", { code = "invalid_token", cause } = {}) {
    super(message, { cause });
    this.name = "OAuthAuthenticationError";
    this.code = code;
  }
}

export function extractBearerToken(authorization) {
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export function normalizeScopes(payload) {
  const raw = payload.scope ?? payload.scp ?? [];
  if (typeof raw === "string") return [...new Set(raw.split(/\s+/).filter(Boolean))];
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    return [...new Set(raw)];
  }
  throw new OAuthAuthenticationError("Access token scope claim is invalid.");
}

export function hasScope(principal, requiredScope) {
  // Legacy/opaque migration principals deliberately use null as an unrestricted
  // scope marker. JWT principals always contain an explicit array.
  return principal.scopes === null || principal.scopes?.includes(requiredScope) === true;
}

export function createOpaqueBearerAuthenticator(store) {
  return {
    kind: "opaque",
    async authenticate(token) {
      return store.authenticate(token);
    },
  };
}

export function createJwtBearerAuthenticator(
  {
    issuer,
    audience,
    jwksUri,
    algorithms = ["RS256"],
    clockToleranceSeconds = 5,
    requireJti = true,
    requiredTyp = null,
  },
  { store, jwks } = {},
) {
  if (!issuer) throw new Error("OAuth issuer is required.");
  if (!audience) throw new Error("OAuth audience/resource is required.");
  if (!store?.resolveOAuthPrincipal) {
    throw new Error("OAuth authentication requires a store with resolveOAuthPrincipal().");
  }
  if (!jwks && !jwksUri) throw new Error("OAuth JWKS URI is required.");
  const keySet = jwks
    ? createLocalJWKSet(jwks)
    : createRemoteJWKSet(new URL(jwksUri), {
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
        timeoutDuration: 5_000,
      });

  return {
    kind: "oauth-jwt",
    issuer,
    audience,
    async verify(token) {
      try {
        const { payload, protectedHeader } = await jwtVerify(token, keySet, {
          issuer,
          audience,
          algorithms,
          clockTolerance: clockToleranceSeconds,
          requiredClaims: ["sub", "iat", "exp", ...(requireJti ? ["jti"] : [])],
        });
        if (requiredTyp && protectedHeader.typ !== requiredTyp) {
          throw new OAuthAuthenticationError("Access token typ header is invalid.");
        }
        const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (tokenAudiences.length !== 1 || tokenAudiences[0] !== audience) {
          throw new OAuthAuthenticationError(
            "Access token audience must be the canonical MCP resource only.",
          );
        }
        const subject = payload.sub;
        const jti = payload.jti ?? null;
        if (requireJti && !jti) {
          throw new OAuthAuthenticationError("Access token jti claim is required.");
        }
        if (jti && (await store.isTokenRevoked({ issuer, jti }))) {
          throw new OAuthAuthenticationError("Access token has been revoked.");
        }
        return {
          issuer,
          subject,
          jti,
          scopes: normalizeScopes(payload),
          claims: payload,
          tokenIssuedAt: isoNumericDate(payload.iat),
          tokenExpiresAt: isoNumericDate(payload.exp),
        };
      } catch (error) {
        if (error instanceof OAuthAuthenticationError) throw error;
        if (error instanceof joseErrors.JOSEError) {
          throw new OAuthAuthenticationError("Access token verification failed.", {
            cause: error,
          });
        }
        throw error;
      }
    },
    async authenticate(token) {
      const verified = await this.verify(token);
      const principal = await store.resolveOAuthPrincipal({
        issuer: verified.issuer,
        subject: verified.subject,
      });
      if (!principal) {
        throw new OAuthAuthenticationError("OAuth subject is not linked to an active workspace.");
      }
      return { ...principal, ...verified };
    },
  };
}

function isoNumericDate(value) {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

function parseAlgorithms(raw) {
  const algorithms = (raw || "RS256")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!algorithms.length || algorithms.includes("none")) {
    throw new Error("OAUTH_JWT_ALGORITHMS must contain signed JWT algorithms.");
  }
  return algorithms;
}

function asBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return /^(1|true|yes)$/i.test(value);
}

export function createAuthenticatorFromEnv(env, { store, audience } = {}) {
  const jwksUri = env.OAUTH_JWKS_URI?.trim();
  if (jwksUri) {
    return createJwtBearerAuthenticator(
      {
        issuer: env.OAUTH_ISSUER?.trim(),
        audience: env.OAUTH_AUDIENCE?.trim() || audience,
        jwksUri,
        algorithms: parseAlgorithms(env.OAUTH_JWT_ALGORITHMS),
        clockToleranceSeconds: Number(env.OAUTH_CLOCK_TOLERANCE_SECONDS ?? 5),
        requireJti: asBoolean(env.OAUTH_REQUIRE_JTI, true),
        requiredTyp: env.OAUTH_REQUIRED_TYP?.trim() || null,
      },
      { store },
    );
  }
  return createOpaqueBearerAuthenticator(store);
}

export async function authenticateAuthorizationHeader(authorization, authenticator) {
  const token = extractBearerToken(authorization);
  if (!token) return null;
  try {
    return await authenticator.authenticate(token);
  } catch (error) {
    if (error instanceof OAuthAuthenticationError) return null;
    throw error;
  }
}
