import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isIgnored, loadIgnorePatterns } from "../src/ignore.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("ignore-patterns.txt excludes lockfiles and data output", () => {
  const patterns = loadIgnorePatterns(join(ROOT, "ignore-patterns.txt"));
  assert.equal(isIgnored("package-lock.json", patterns), true);
  assert.equal(isIgnored("apps/web/yarn.lock", patterns), true);
  assert.equal(isIgnored("data/timeseries.json", patterns), true);
  assert.equal(isIgnored("node_modules/lodash/index.js", patterns), true);
  assert.equal(isIgnored("dist/bundle.js", patterns), true);
  assert.equal(isIgnored("fixtures/sample.json", patterns), true);
});

test("ignore-patterns.txt keeps ordinary source and config", () => {
  const patterns = loadIgnorePatterns(join(ROOT, "ignore-patterns.txt"));
  assert.equal(isIgnored("src/collect.mjs", patterns), false);
  assert.equal(isIgnored("package.json", patterns), false);
  assert.equal(isIgnored("config.json", patterns), false);
  assert.equal(isIgnored(".github/workflows/collect.yml", patterns), false);
  assert.equal(isIgnored("README.md", patterns), false);
  assert.equal(isIgnored("docker-compose.yml", patterns), false);
  assert.equal(isIgnored("app/models/user.py", patterns), false);
});
