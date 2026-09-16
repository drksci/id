import { FailClosedError, SUBJECT_KIND } from "./runtime.js";

export const AUTH_LIMITS = Object.freeze({
  TOKEN_BYTES: 16 * 1024,
  CLOCK_SKEW_SECONDS: 30,
  JWKS_CACHE_MS: 5 * 60 * 1000,
});

export const ACCESS_DEFAULT_AUDIENCE = "id-worker";

const jwksCache = new Map();

function reject(code, message = code, status = 401) {
  throw new FailClosedError(code, message, status);
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) reject("invalid_token", "malformed JWT encoding");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { reject("invalid_token", "malformed JWT encoding"); }
}

function decodeJson(value, code = "invalid_token") {
  try { return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))); } catch { reject(code, "malformed JWT JSON"); }
}

function claimText(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) reject("invalid_token", `${field} claim is invalid`);
  return value;
}

function audiences(value) {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)) return value;
  reject("invalid_token", "aud claim is invalid");
}

export function normalizeAccessTeamDomain(value) {
  if (typeof value !== "string" || value.trim().length === 0) reject("authentication_unavailable", "Access team domain is not configured", 503);
  const raw = value.trim().replace(/\/+$/, "");
  let parsed;
  try { parsed = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { reject("authentication_unavailable", "Access team domain is invalid", 503); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.hostname || parsed.hostname.includes("." ) === false) reject("authentication_unavailable", "Access team domain is invalid", 503);
  return parsed.hostname.toLowerCase();
}

export function resolveAccessConfig(env = {}) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN && normalizeAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const issuer = typeof env.ACCESS_ISSUER === "string" && env.ACCESS_ISSUER.length > 0 ? env.ACCESS_ISSUER : teamDomain ? `https://${teamDomain}` : undefined;
  const jwks = typeof env.ACCESS_JWKS_URL === "string" && env.ACCESS_JWKS_URL.length > 0 ? env.ACCESS_JWKS_URL : teamDomain ? `https://${teamDomain}/cdn-cgi/access/certs` : undefined;
  if (!issuer) reject("authentication_unavailable", "Access issuer is not configured", 503);
  if (!jwks) reject("authentication_unavailable", "Access JWKS URL is not configured", 503);
  return { issuer, jwks, audience: typeof env.ACCESS_AUDIENCE === "string" && env.ACCESS_AUDIENCE.length > 0 ? [env.ACCESS_AUDIENCE] : Array.isArray(env.ACCESS_AUDIENCE) && env.ACCESS_AUDIENCE.length > 0 ? env.ACCESS_AUDIENCE : [ACCESS_DEFAULT_AUDIENCE] };
}

function scopes(payload, kind, env) {
  const value = payload.scopes ?? payload.scope;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) return [...new Set(value)];
  if (typeof value === "string" && value.trim()) return [...new Set(value.trim().split(/\s+/))];
  const configured = kind === SUBJECT_KIND.HUMAN ? env.ACCESS_HUMAN_SCOPES : env.ACCESS_AGENT_SCOPES;
  if (Array.isArray(configured) && configured.length > 0) return configured;
  if (typeof configured === "string" && configured.trim()) return configured.trim().split(/\s+/);
  reject("invalid_token", "scope claim is required");
}

function expectedAudience(env) {
  const value = env.ACCESS_AUDIENCE || env.AUDIENCE;
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value) && value.length > 0) return value;
  return [ACCESS_DEFAULT_AUDIENCE];
}

function expectedIssuer(env) {
  const value = env.ACCESS_ISSUER;
  if (typeof value === "string" && value.length > 0) return value;
  return resolveAccessConfig(env).issuer;
}

function jwksUrl(env) {
  const value = env.ACCESS_JWKS_URL;
  if (typeof value === "string" && value.length > 0) {
    try { return new URL(value).toString(); } catch { reject("authentication_unavailable", "Access JWKS URL is invalid", 503); }
  }
  return new URL(resolveAccessConfig(env).jwks).toString();
}

async function loadJwks(url, fetcher, forceRefresh = false) {
  const cached = jwksCache.get(url);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  let response;
  try { response = await fetcher(url, { headers: { accept: "application/json" } }); } catch { reject("jwks_unavailable", "Access key service is unavailable", 503); }
  if (!response?.ok) reject("jwks_unavailable", "Access key service rejected the request", 503);
  let document;
  try { document = await response.json(); } catch { reject("jwks_unavailable", "Access key document is malformed", 503); }
  if (!document || !Array.isArray(document.keys) || document.keys.length === 0) reject("jwks_unavailable", "Access key document has no keys", 503);
  const keys = new Map();
  for (const key of document.keys) {
    if (key && typeof key.kid === "string" && key.kty === "RSA" && (!key.alg || key.alg === "RS256")) keys.set(key.kid, key);
  }
  if (keys.size === 0) reject("jwks_unavailable", "Access key document has no usable RSA keys", 503);
  jwksCache.set(url, { keys, expiresAt: Date.now() + AUTH_LIMITS.JWKS_CACHE_MS });
  return keys;
}

async function verifySignature(token, header, fetcher, url) {
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) reject("invalid_token", "JWT must use a keyed RS256 signature");
  let jwk = (await loadJwks(url, fetcher)).get(header.kid);
  if (!jwk) jwk = (await loadJwks(url, fetcher, true)).get(header.kid);
  if (!jwk) reject("invalid_token", "JWT signing key is unknown");
  let key;
  try { key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]); } catch { reject("jwks_unavailable", "JWT signing key is unusable", 503); }
  const separator = token.indexOf(".", token.indexOf(".") + 1);
  const signingInput = new TextEncoder().encode(token.slice(0, separator));
  const signature = decodeBase64Url(token.slice(separator + 1));
  try {
    if (!(await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signingInput))) reject("invalid_token", "JWT signature was rejected");
  } catch (error) {
    if (error instanceof FailClosedError) throw error;
    reject("invalid_token", "JWT signature was rejected");
  }
}

export function clearJwksCache() { jwksCache.clear(); }

export async function verifyAccessJwt(request, env = {}, { fetcher = globalThis.fetch, now = Date.now() } = {}) {
  const authorization = request?.headers?.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) reject("authentication_required", "Bearer authentication is required");
  const token = authorization.slice("Bearer ".length).trim();
  if (!token || new TextEncoder().encode(token).byteLength > AUTH_LIMITS.TOKEN_BYTES) reject("invalid_token", "JWT is malformed");
  const parts = token.split(".");
  if (parts.length !== 3) reject("invalid_token", "JWT is malformed");
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") reject("invalid_token", "JWT is malformed");
  const issuer = expectedIssuer(env);
  const audience = audiences(payload.aud);
  if (payload.iss !== issuer) reject("issuer_mismatch", "JWT issuer is not trusted");
  if (!expectedAudience(env).some((item) => audience.includes(item))) reject("wrong_audience", "JWT audience is not trusted");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= (now / 1000) - AUTH_LIMITS.CLOCK_SKEW_SECONDS) reject("subject_expired", "JWT has expired");
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > (now / 1000) + AUTH_LIMITS.CLOCK_SKEW_SECONDS)) reject("invalid_token", "JWT is not active");
  await verifySignature(token, header, fetcher, jwksUrl(env));
  const kind = payload.kind === SUBJECT_KIND.AGENT || payload.subject_kind === SUBJECT_KIND.AGENT ? SUBJECT_KIND.AGENT : SUBJECT_KIND.HUMAN;
  const sub = claimText(payload.sub, "sub");
  const claim = {
    sub,
    kind,
    issuer,
    audience,
    scopes: scopes(payload, kind, env),
    environment: payload.environment || env.APP_ENV,
    expires_at: new Date(payload.exp * 1000).toISOString(),
    jti: claimText(payload.jti || `${sub}:${payload.iat || payload.exp}`, "jti"),
  };
  if (kind === SUBJECT_KIND.AGENT) claim.parent_id = claimText(payload.parent_id, "parent_id");
  return { verified: true, claim };
}

export const defaultAuthenticate = verifyAccessJwt;
