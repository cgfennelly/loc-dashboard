import { readFileSync } from "node:fs";

export function loadCommitters(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * Classify a commit into a committer id (human | agent | unknown | custom).
 * Agent rules are evaluated before human rules as listed in committers.json.
 */
export function classifyCommit(commit, committersConfig) {
  const author = commit.author || {};
  const committer = commit.committer || {};
  const message = commit.message || "";
  const ctx = {
    login: (author.login || "").toLowerCase(),
    email: (author.email || committer.email || "").toLowerCase(),
    name: (author.name || committer.name || "").toLowerCase(),
    message,
  };

  for (const rule of committersConfig.rules || []) {
    const clauses = rule.any || [];
    if (clauses.some((clause) => matchClause(clause, ctx))) {
      return { id: rule.id, label: rule.label };
    }
  }

  return {
    id: committersConfig.defaultId || "unknown",
    label: committersConfig.defaultLabel || "Other",
  };
}

function matchClause(clause, ctx) {
  if (clause.login && clause.login.toLowerCase() !== ctx.login) return false;
  if (clause.email && clause.email.toLowerCase() !== ctx.email) return false;
  if (
    clause.emailEndsWith &&
    !ctx.email.endsWith(clause.emailEndsWith.toLowerCase())
  ) {
    return false;
  }
  if (
    clause.emailContains &&
    !ctx.email.includes(clause.emailContains.toLowerCase())
  ) {
    return false;
  }
  if (
    clause.nameEquals &&
    clause.nameEquals.toLowerCase() !== ctx.name
  ) {
    return false;
  }
  if (
    clause.coAuthoredByContains &&
    !ctx.message.toLowerCase().includes(clause.coAuthoredByContains.toLowerCase())
  ) {
    return false;
  }

  // If the clause only had fields that passed (or were absent), treat as match
  // when at least one positive field was specified.
  return Boolean(
    clause.login ||
      clause.email ||
      clause.emailEndsWith ||
      clause.emailContains ||
      clause.nameEquals ||
      clause.coAuthoredByContains,
  );
}

export function committerLegend(committersConfig) {
  const legend = {};
  for (const rule of committersConfig.rules || []) {
    legend[rule.id] = rule.label;
  }
  legend[committersConfig.defaultId || "unknown"] =
    committersConfig.defaultLabel || "Other";
  return legend;
}