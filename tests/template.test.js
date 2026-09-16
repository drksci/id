import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const templatePath = new URL("../wrangler.jsonc", import.meta.url);
const templateSource = readFileSync(templatePath, "utf8");
const template = JSON.parse(stripComments(templateSource));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const operatorSource = readFileSync(new URL("../infra/wrangler.toml", import.meta.url), "utf8");

// The public one-click template is JSONC. Comments are documentation, not values.
function stripComments(source) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inLineComment) {
      if (char === "\n") { inLineComment = false; out += char; }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") { inBlockComment = false; index += 1; }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") { out += next ?? ""; index += 1; continue; }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; out += char; continue; }
    if (char === "/" && next === "/") { inLineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { inBlockComment = true; index += 1; continue; }
    out += char;
  }
  return out;
}

test("public template config is valid and deploys without operator setup", () => {
  assert.equal(template.main, "src/index.ts");
  assert.equal(template.compatibility_date.length, 10);
  assert.equal(template.workers_dev, true, "a fresh deployment must be reachable immediately");
  assert.deepEqual(template.assets, {
    directory: "./public",
    binding: "ASSETS",
    run_worker_first: ["/api/*", "/healthz", "/readyz", "/approve/*"],
  });
});

test("public template config carries no operator values", () => {
  // No environment placeholders, no operator identity, no real resource identifiers.
  assert.ok(!templateSource.includes("${"), "template config must not use unrendered placeholders");
  assert.ok(!/drksci/i.test(templateSource), "template config must not name this repository's operator");
  assert.ok(!/drksci/i.test(JSON.stringify(template)), "template config values must stay generic");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(templateSource), "template config must not pin a resource ID");
  assert.ok(!/\.(com|dev|net|org)\b/.test(templateSource), "template config must not pin a hostname or domain");
  assert.equal(template.d1_databases, undefined, "durable state is opt-in, not part of the instant path");
  assert.equal(template.vars, undefined, "no deployment variables are required to boot");
});

test("operator contract stays separate from the public template", () => {
  // The operator path keeps its own file, its own Worker name, and its own explicit IDs.
  assert.ok(operatorSource.includes("${D1_DATABASE_ID_PROD}"));
  assert.ok(operatorSource.includes("id-worker"));
  assert.ok(!operatorSource.includes("id-gateway"), "the operator config must not target the public template Worker");
  assert.notEqual(template.name, "id-worker", "a mistaken root deploy must not shadow the operator Worker");
});

test("README publishes the one-click deploy button", () => {
  assert.ok(readme.includes("https://deploy.workers.cloudflare.com/button"));
  assert.ok(readme.includes("https://deploy.workers.cloudflare.com/?url=https://github.com/drksci/id"));
  assert.ok(readme.includes("wrangler.jsonc"));
});
