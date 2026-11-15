# loc-dashboard

Daily lines-of-code dashboard for your GitHub trunk (default branch) commits.

- Counts **filtered additions** that landed on each repo’s default branch
- Skips **merge commits** and non-trunk branches
- Tags each line with **repo**, **day**, and **committer** (`human` / `agent` / …)
- Applies a shared blacklist: [`ignore-patterns.txt`](./ignore-patterns.txt)
- Rebuilds full history each run (no incremental store required)
- Publishes a cumulative chart via **GitHub Actions → GitHub Pages**

## Quick start

```bash
# Token needs read access to the private repos you want counted
export LOC_GITHUB_TOKEN=ghp_...
npm test
npm run collect
```

Then open `docs/index.html` with a local static server (so `fetch` can load `data/`):

```bash
python3 -m http.server 8080 --directory docs
# in another terminal, also expose data — or use the Action-built Pages bundle
```

For local preview matching Pages layout:

```bash
mkdir -p _site/data && cp docs/* _site/ && cp data/timeseries*.json _site/data/
python3 -m http.server 8080 --directory _site
```

## GitHub Actions setup

1. Create an empty private repository named `loc-dashboard` under your account (no README/license).
2. Push this project to it (`git remote add origin … && git push -u origin main`).
3. Add a secret **`LOC_GITHUB_TOKEN`**: a classic PAT with `repo` scope, or a fine-grained token that can read every private repo you want included. The default `GITHUB_TOKEN` can only see *this* repository, which is not enough for a multi-repo tally.
4. Enable **Settings → Pages → Source: GitHub Actions**.
5. Run **Actions → Collect LOC → Run workflow**.

The workflow:

1. Recomputes trunk LOC across configured repos  
2. Commits `data/timeseries.json`  
3. Deploys `docs/` + `data/` to GitHub Pages  

> **Private Pages note:** GitHub Pages for *private* repos requires GitHub Pro/Team. On a free plan, keep the repo private for data collection and open the committed `docs/` + `data/` locally, or make the repo public if you are comfortable sharing aggregate LOC stats.

## Configuration

| File | Purpose |
| --- | --- |
| `config.json` | Owner, fork/archive filters, allow/block lists, `extraRepos`, `maxFileAdditions` |
| `committers.json` | Rules mapping author email/login/Co-authored-by → `human` / `agent` / … |
| `ignore-patterns.txt` | Single blacklist of paths excluded from LOC |

### Ignore philosophy

We **err on including** hand-written source and config (TS/JS/Py, YAML, Markdown, `package.json`, Dockerfiles, …).

We **exclude** things that distort “lines of code”:

- Lockfiles and vendored trees  
- Build/minified artefacts  
- Media/binaries/databases/CSV dumps  
- Snapshot/fixture JSON blobs  
- This project’s own `data/timeseries*.json`  
- Single-file additions larger than `maxFileAdditions` (default **2000**) — catches pasted dumps

Tune `ignore-patterns.txt` when a chart spike looks wrong.

### Extra / bootcamp repos

Add any still-accessible repos under another account to `config.json`:

```json
"extraRepos": ["northcoders/some-project"]
```

## Metric

Primary chart metric = **cumulative filtered additions** on trunk, stacked by committer.

Deletions are stored in the JSON for later slicing; they are not the cumulative y-axis.

## Committer detection

From `committers.json` (first match wins):

1. Cursor Agent email / `@cursor.com` / `Co-authored-by: Cursor` → **agent**  
2. Your login / emails → **human**  
3. Everything else → **unknown** (shown as Other)

Add more rules when new bots or collaborators appear.
