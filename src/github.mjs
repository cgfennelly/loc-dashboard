const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

export function createClient(token) {
  if (!token) {
    throw new Error(
      "Missing GitHub token. Set LOC_GITHUB_TOKEN or GITHUB_TOKEN.",
    );
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "loc-dashboard",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function request(url, { method = "GET", body, raw = false } = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await fetch(url, {
        method,
        headers: body
          ? { ...headers, "Content-Type": "application/json" }
          : headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 202) {
        await sleep(1500 * (attempt + 1));
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") || 0);
        const waitMs = retryAfter ? retryAfter * 1000 : 2000 * (attempt + 1);
        await sleep(Math.min(waitMs, 60_000));
        continue;
      }

      if (res.status === 403) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        const retryAfter = Number(res.headers.get("retry-after") || 0);
        // Only retry rate-limit style 403s, not permission errors.
        if (remaining === "0" || retryAfter > 0) {
          const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
          const waitMs = retryAfter
            ? retryAfter * 1000
            : reset
              ? Math.max(1000, reset * 1000 - Date.now())
              : 2000 * (attempt + 1);
          await sleep(Math.min(waitMs, 60_000));
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${method} ${url} → ${res.status}: ${text}`);
      }

      if (raw) return res;
      if (res.status === 204) return null;
      return res.json();
    }
    throw new Error(`Exceeded retries for ${method} ${url}`);
  }

  async function graphql(query, variables = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await fetch(GITHUB_GRAPHQL, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 403 || res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }

      const payload = await res.json();
      if (payload.errors?.length) {
        const msg = payload.errors.map((e) => e.message).join("; ");
        // Transient secondary rate limits sometimes surface as GraphQL errors
        if (/rate limit/i.test(msg) && attempt < 7) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw new Error(`GraphQL error: ${msg}`);
      }
      return payload.data;
    }
    throw new Error("Exceeded GraphQL retries");
  }

  return { request, graphql, headers };
}

const REPOS_QUERY = `
query ($owner: String!, $after: String) {
  user(login: $owner) {
    repositories(
      first: 100
      after: $after
      ownerAffiliations: [OWNER]
      orderBy: { field: NAME, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        nameWithOwner
        isPrivate
        isFork
        isArchived
        defaultBranchRef { name }
      }
    }
  }
}
`;

/**
 * List repositories owned by `owner`.
 * Uses GraphQL (works with user PATs and many GitHub App installation tokens).
 * Falls back to REST /user/repos when GraphQL is unavailable.
 */
export async function listOwnedRepos(client, { owner, includeForks, includeArchived }) {
  try {
    return await listOwnedReposGraphql(client, {
      owner,
      includeForks,
      includeArchived,
    });
  } catch (err) {
    console.warn(`GraphQL repo list failed (${err.message}); trying REST…`);
    return listOwnedReposRest(client, { owner, includeForks, includeArchived });
  }
}

async function listOwnedReposGraphql(client, { owner, includeForks, includeArchived }) {
  const repos = [];
  let after = null;
  for (;;) {
    const data = await client.graphql(REPOS_QUERY, { owner, after });
    const connection = data.user?.repositories;
    if (!connection) {
      throw new Error(`No repositories connection for user ${owner}`);
    }
    for (const node of connection.nodes || []) {
      if (!includeForks && node.isFork) continue;
      if (!includeArchived && node.isArchived) continue;
      repos.push({
        name: node.name,
        fullName: node.nameWithOwner,
        defaultBranch: node.defaultBranchRef?.name || "main",
        private: node.isPrivate,
        fork: node.isFork,
        archived: node.isArchived,
      });
    }
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return repos;
}

async function listOwnedReposRest(client, { owner, includeForks, includeArchived }) {
  const repos = [];
  let page = 1;
  while (true) {
    const batch = await client.request(
      `${GITHUB_API}/user/repos?affiliation=owner&per_page=100&page=${page}&sort=full_name`,
    );
    if (!batch.length) break;
    for (const repo of batch) {
      if (repo.owner?.login !== owner) continue;
      if (!includeForks && repo.fork) continue;
      if (!includeArchived && repo.archived) continue;
      repos.push({
        name: repo.name,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        private: repo.private,
        fork: repo.fork,
        archived: repo.archived,
      });
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return repos;
}

export async function resolveExtraRepo(client, fullName) {
  const [owner, name] = fullName.split("/");
  const repo = await client.request(`${GITHUB_API}/repos/${owner}/${name}`);
  return {
    name: repo.name,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    private: repo.private,
    fork: repo.fork,
    archived: repo.archived,
  };
}

const HISTORY_QUERY = `
query ($owner: String!, $name: String!, $after: String, $since: GitTimestamp) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: 100, after: $after, since: $since) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid
              authoredDate
              committedDate
              message
              additions
              deletions
              author {
                name
                email
                user { login }
              }
              committer {
                name
                email
                user { login }
              }
              parents { totalCount }
            }
          }
        }
      }
    }
  }
}
`;

export async function* iterateTrunkCommits(client, { owner, name, since }) {
  let after = null;
  for (;;) {
    const data = await client.graphql(HISTORY_QUERY, {
      owner,
      name,
      after,
      since: since || null,
    });
    const history = data.repository?.defaultBranchRef?.target?.history;
    if (!history) return;

    for (const node of history.nodes || []) {
      yield {
        oid: node.oid,
        authoredDate: node.authoredDate,
        committedDate: node.committedDate,
        message: node.message || "",
        additions: node.additions ?? 0,
        deletions: node.deletions ?? 0,
        parentCount: node.parents?.totalCount ?? 1,
        author: {
          name: node.author?.name || "",
          email: node.author?.email || "",
          login: node.author?.user?.login || "",
        },
        committer: {
          name: node.committer?.name || "",
          email: node.committer?.email || "",
          login: node.committer?.user?.login || "",
        },
      };
    }

    if (!history.pageInfo.hasNextPage) return;
    after = history.pageInfo.endCursor;
  }
}

export async function getCommitFiles(client, { owner, name, oid }) {
  const data = await client.request(
    `${GITHUB_API}/repos/${owner}/${name}/commits/${oid}`,
  );
  return (data.files || []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    changes: f.changes ?? 0,
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
