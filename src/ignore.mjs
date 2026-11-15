import { readFileSync } from "node:fs";

/**
 * Load gitignore-style patterns from a file.
 * Supports # comments, blank lines, **, *, ?, and leading / (repo-root anchor).
 */
export function loadIgnorePatterns(filePath) {
  const text = readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(compilePattern);
}

export function isIgnored(path, patterns) {
  const normalised = path.replaceAll("\\", "/").replace(/^\/+/, "");
  return patterns.some((re) => re.test(normalised));
}

function compilePattern(pattern) {
  let p = pattern.replaceAll("\\", "/");
  let anchored = false;
  if (p.startsWith("/")) {
    anchored = true;
    p = p.slice(1);
  }
  // Trailing slash → directory prefix
  if (p.endsWith("/")) {
    p += "**";
  }

  let regex = "^";
  if (!anchored && !p.startsWith("**/") && !p.startsWith("**")) {
    // Match in any directory, like gitignore unanchored patterns
    regex += "(?:.*/)?";
  }

  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
    } else if (c === "*") {
      regex += "[^/]*";
    } else if (c === "?") {
      regex += "[^/]";
    } else if ("+.^$()[]{}|\\".includes(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }
  regex += "$";
  return new RegExp(regex);
}
