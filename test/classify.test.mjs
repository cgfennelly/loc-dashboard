import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { classifyCommit, loadCommitters } from "../src/classify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const committers = loadCommitters(join(ROOT, "committers.json"));

test("classifies Cursor Agent by email", () => {
  const result = classifyCommit(
    {
      author: { email: "cursoragent@cursor.com", name: "Cursor Agent", login: "" },
      message: "feat: add dashboard",
    },
    committers,
  );
  assert.equal(result.id, "agent");
});

test("classifies human by login", () => {
  const result = classifyCommit(
    {
      author: {
        email: "cgfennelly@users.noreply.github.com",
        name: "cgfennelly",
        login: "cgfennelly",
      },
      message: "fix typo",
    },
    committers,
  );
  assert.equal(result.id, "human");
});

test("classifies local git identity as human", () => {
  const result = classifyCommit(
    {
      author: {
        email: "chrisfennelly@Chriss-MacBook-Air.local",
        name: "Chris Fennelly",
        login: "",
      },
      message: "initial commit",
    },
    committers,
  );
  assert.equal(result.id, "human");
});

test("treats Co-authored-by Cursor as agent", () => {
  const result = classifyCommit(
    {
      author: {
        email: "c.g.fennelly@gmail.com",
        name: "Conor",
        login: "cgfennelly",
      },
      message: "ship it\n\nCo-authored-by: Cursor <cursoragent@cursor.com>",
    },
    committers,
  );
  assert.equal(result.id, "agent");
});
