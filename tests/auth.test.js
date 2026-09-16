import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAccessTeamDomain, resolveAccessConfig } from "../src/auth.js";

test("Cloudflare Access team domain derives issuer, JWKS URL, and default audience", () => {
  assert.deepEqual(resolveAccessConfig({ ACCESS_TEAM_DOMAIN: "https://team.example/" }), {
    issuer: "https://team.example",
    jwks: "https://team.example/cdn-cgi/access/certs",
    audience: ["id-worker"],
  });
  assert.equal(normalizeAccessTeamDomain("team.example///"), "team.example");
});

test("explicit Access values override the team-domain fallback", () => {
  assert.deepEqual(resolveAccessConfig({ ACCESS_TEAM_DOMAIN: "team.example", ACCESS_ISSUER: "https://issuer.example", ACCESS_JWKS_URL: "https://issuer.example/keys", ACCESS_AUDIENCE: "custom-audience" }), {
    issuer: "https://issuer.example",
    jwks: "https://issuer.example/keys",
    audience: ["custom-audience"],
  });
});

test("missing or invalid Access configuration fails closed", () => {
  assert.throws(() => resolveAccessConfig({}), (error) => error.code === "authentication_unavailable" && error.status === 503);
  assert.throws(() => normalizeAccessTeamDomain("http://team.example"), (error) => error.code === "authentication_unavailable");
  assert.throws(() => normalizeAccessTeamDomain("https://user:secret@team.example"), (error) => error.code === "authentication_unavailable");
});
