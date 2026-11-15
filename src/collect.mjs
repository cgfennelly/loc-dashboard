#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyCommit, committerLegend, loadCommitters } from "./classify.mjs";
import {
  createClient,
  getCommitFiles,
  iterateTrunkCommits,
  listOwnedRepos,
  resolveExtraRepo,
} from "./github.mjs";
import { isIgnored, loadIgnorePatterns } from "./ignore.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
  const committers = loadCommitters(join(ROOT, "committers.json"));
  const ignorePatterns = loadIgnorePatterns(join(ROOT, "ignore-patterns.txt"));
  const token = process.env.LOC_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  const client = createClient(token);

  const repos = await selectRepos(client, config);
  console.log(`Scanning ${repos.length} repo(s) on default-branch trunk…`);

  /** @type {Map<string, any>} */
  const dayMap = new Map();
  const repoTotals = {};
  const committerTotals = {};
  /** @type {Map<string, any>} */
  const contributorMap = new Map();
  const authorBlock = normalisedAuthorBlocklist(config.authorBlocklist || []);
  let commitsSeen = 0;
  let commitsCounted = 0;
  let commitsAuthorBlocked = 0;
  let filesIgnored = 0;
  let filesOversized = 0;

  for (const repo of repos) {
    const [owner, name] = repo.fullName.split("/");
    console.log(`  • ${repo.fullName} (${repo.defaultBranch})`);

    for await (const commit of iterateTrunkCommits(client, {
      owner,
      name,
      since: config.historySince,
    })) {
      commitsSeen += 1;

      if (config.skipMergeCommits !== false && commit.parentCount > 1) {
        continue;
      }

      if (isAuthorBlocked(commit, authorBlock)) {
        commitsAuthorBlocked += 1;
        continue;
      }

      const who = classifyCommit(commit, committers);
      let additions = 0;
      let deletions = 0;

      // Prefer per-file REST stats so ignore-patterns.txt can apply.
      // Fall back to commit-level totals if the files endpoint fails.
      try {
        const files = await getCommitFiles(client, { owner, name, oid: commit.oid });
        for (const file of files) {
          if (isIgnored(file.filename, ignorePatterns)) {
            filesIgnored += 1;
            continue;
          }
          if (
            config.maxFileAdditions &&
            file.additions > config.maxFileAdditions
          ) {
            filesOversized += 1;
            continue;
          }
          additions += file.additions;
          deletions += file.deletions;
        }
      } catch (err) {
        console.warn(
          `    ! file stats failed for ${commit.oid.slice(0, 7)}: ${err.message}`,
        );
        additions = commit.additions;
        deletions = commit.deletions;
      }

      if (additions === 0 && deletions === 0) {
        continue;
      }

      commitsCounted += 1;
      const day = (commit.authoredDate || commit.committedDate).slice(0, 10);
      bump(dayMap, day, who.id, repo.fullName, additions, deletions);
      bumpNested(repoTotals, repo.fullName, who.id, additions, deletions);
      bumpNested(committerTotals, who.id, "_", additions, deletions);
      bumpContributor(contributorMap, commit, who, repo.fullName, additions, deletions);
    }
  }

  const days = [...dayMap.keys()].sort();
  const daily = days.map((date) => {
    const entry = dayMap.get(date);
    return {
      date,
      byCommitter: entry.byCommitter,
      byRepo: entry.byRepo,
      additions: sumField(entry.byCommitter, "additions"),
      deletions: sumField(entry.byCommitter, "deletions"),
      net: sumField(entry.byCommitter, "net"),
      commits: sumField(entry.byCommitter, "commits"),
    };
  });

  const legend = committerLegend(committers);
  const committerIds = uniqueIds(daily, legend);

  const cumulative = [];
  const running = Object.fromEntries(committerIds.map((id) => [id, 0]));
  let runningTotal = 0;
  for (const day of daily) {
    for (const id of committerIds) {
      const add = day.byCommitter[id]?.additions || 0;
      running[id] += add;
      runningTotal += add;
    }
    cumulative.push({
      date: day.date,
      total: runningTotal,
      byCommitter: { ...running },
    });
  }

  const contributors = [...contributorMap.values()]
    .map((row) => ({
      ...row,
      repos: [...row.repos].sort(),
    }))
    .sort(
      (a, b) =>
        b.additions - a.additions ||
        (a.displayName || "").localeCompare(b.displayName || ""),
    );

  const output = {
    generatedAt: new Date().toISOString(),
    metric: "additions",
    metricNote:
      "Cumulative chart sums filtered additions on the default branch (trunk). Merge commits skipped. Ignored paths, blocklisted repos/authors, and oversized single-file adds excluded.",
    committers: legend,
    summary: {
      reposScanned: repos.length,
      commitsSeen,
      commitsCounted,
      commitsAuthorBlocked,
      filesIgnored,
      filesOversized,
      totalAdditions: runningTotal,
      byCommitter: Object.fromEntries(
        committerIds.map((id) => [
          id,
          {
            label: legend[id] || id,
            additions: committerTotals[id]?._?.additions || 0,
            deletions: committerTotals[id]?._?.deletions || 0,
            net: committerTotals[id]?._?.net || 0,
            commits: committerTotals[id]?._?.commits || 0,
          },
        ]),
      ),
      byRepo: repoTotals,
      contributors,
    },
    daily,
    cumulative,
  };

  const outPath = join(ROOT, config.outputPath || "data/timeseries.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  // Compact copy for the dashboard fetch
  const minPath = join(dirname(outPath), "timeseries.min.json");
  writeFileSync(minPath, JSON.stringify(output) + "\n");

  console.log(`Wrote ${outPath}`);
  console.log(
    `Counted ${commitsCounted}/${commitsSeen} commits; ignored ${filesIgnored} files; skipped ${filesOversized} oversized files.`,
  );
  console.log(`Total filtered additions: ${runningTotal}`);
}

async function selectRepos(client, config) {
  const allow = new Set(config.repoAllowlist || []);
  const block = new Set(config.repoBlocklist || []);
  let repos = [];

  // If an allowlist is set, resolve those repos directly (avoids needing
  // a token that can enumerate every owned repository).
  if (allow.size) {
    for (const entry of allow) {
      const fullName = entry.includes("/")
        ? entry
        : `${config.owner}/${entry}`;
      try {
        repos.push(await resolveExtraRepo(client, fullName));
      } catch (err) {
        console.warn(`Skipping allowlisted repo ${fullName}: ${err.message}`);
      }
    }
  } else {
    repos = await listOwnedRepos(client, {
      owner: config.owner,
      includeForks: Boolean(config.includeForks),
      includeArchived: Boolean(config.includeArchived),
    });
  }

  repos = repos.filter((r) => !block.has(r.fullName) && !block.has(r.name));

  for (const fullName of config.extraRepos || []) {
    if (repos.some((r) => r.fullName === fullName)) continue;
    try {
      repos.push(await resolveExtraRepo(client, fullName));
    } catch (err) {
      console.warn(`Skipping extra repo ${fullName}: ${err.message}`);
    }
  }

  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function emptyBucket() {
  return { additions: 0, deletions: 0, net: 0, commits: 0 };
}

function bump(dayMap, day, committerId, repoFullName, additions, deletions) {
  if (!dayMap.has(day)) {
    dayMap.set(day, { byCommitter: {}, byRepo: {} });
  }
  const entry = dayMap.get(day);

  if (!entry.byCommitter[committerId]) entry.byCommitter[committerId] = emptyBucket();
  const c = entry.byCommitter[committerId];
  c.additions += additions;
  c.deletions += deletions;
  c.net += additions - deletions;
  c.commits += 1;

  if (!entry.byRepo[repoFullName]) entry.byRepo[repoFullName] = {};
  if (!entry.byRepo[repoFullName][committerId]) {
    entry.byRepo[repoFullName][committerId] = emptyBucket();
  }
  const r = entry.byRepo[repoFullName][committerId];
  r.additions += additions;
  r.deletions += deletions;
  r.net += additions - deletions;
  r.commits += 1;
}

function bumpNested(map, outerKey, innerKey, additions, deletions) {
  if (!map[outerKey]) map[outerKey] = {};
  if (!map[outerKey][innerKey]) map[outerKey][innerKey] = emptyBucket();
  const bucket = map[outerKey][innerKey];
  bucket.additions += additions;
  bucket.deletions += deletions;
  bucket.net += additions - deletions;
  bucket.commits += 1;
}

function bumpContributor(map, commit, who, repoFullName, additions, deletions) {
  const login = (commit.author?.login || "").trim();
  const email = (commit.author?.email || commit.committer?.email || "").trim();
  const name = (commit.author?.name || commit.committer?.name || "").trim();
  const key = (login || email || name || "unknown").toLowerCase();

  if (!map.has(key)) {
    map.set(key, {
      key,
      login: login || null,
      email: email || null,
      name: name || null,
      displayName: name || login || email || "unknown",
      bucket: who.id,
      label: who.label,
      additions: 0,
      deletions: 0,
      net: 0,
      commits: 0,
      repos: new Set(),
    });
  }

  const row = map.get(key);
  // Prefer richer identity fields as we see them
  if (login && !row.login) row.login = login;
  if (email && !row.email) row.email = email;
  if (name && !row.name) {
    row.name = name;
    row.displayName = name;
  }
  row.bucket = who.id;
  row.label = who.label;
  row.additions += additions;
  row.deletions += deletions;
  row.net += additions - deletions;
  row.commits += 1;
  row.repos.add(repoFullName);
}

function normalisedAuthorBlocklist(entries) {
  return entries
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
}

function isAuthorBlocked(commit, blocklist) {
  if (!blocklist.length) return false;
  const haystacks = [
    commit.author?.login,
    commit.author?.email,
    commit.author?.name,
    commit.committer?.login,
    commit.committer?.email,
    commit.committer?.name,
  ]
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);

  return haystacks.some((value) =>
    blocklist.some((blocked) => value === blocked || value.includes(blocked)),
  );
}

function sumField(byCommitter, field) {
  return Object.values(byCommitter || {}).reduce(
    (sum, bucket) => sum + (bucket[field] || 0),
    0,
  );
}

function uniqueIds(daily, legend) {
  const ids = new Set(Object.keys(legend));
  for (const day of daily) {
    for (const id of Object.keys(day.byCommitter || {})) ids.add(id);
  }
  // Stable preferred order
  const preferred = ["human", "agent", "unknown"];
  const rest = [...ids].filter((id) => !preferred.includes(id)).sort();
  return [...preferred.filter((id) => ids.has(id)), ...rest];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
