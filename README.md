# makefun-forge

A GitHub-compatible git forge in one Node 22 program — stdlib only, no
dependencies, no git binary. Built for the make.fun `github-core-clone-01`
bounty.

## Run

```
MAKEFUN_ENV_URL=http://127.0.0.1:PORT \
MAKEFUN_SHOP_TOKEN=<token> \
node main.ts
```

`main.ts` binds an ephemeral port, POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, long-polls `$MAKEFUN_ENV_URL/done`, and exits 0
when done.

## Surfaces (one process, one in-memory store)

- **Git smart HTTP** at `/{owner}/{repo}.git`:
  upload-pack protocol v2 (capability advertisement + `ls-refs`) and
  receive-pack v0 (`report-status`, `side-band-64k`, `delete-refs`,
  fast-forward only — non-FF updates are refused per ref with
  `ng <ref> non-fast-forward`). Packfiles (plain objects, zlib) and the
  pkt-line protocol are implemented in code; no git binary is used.
- **REST v3** under `/api/v3`: repos, branches, git refs, commits, contents
  (create/update/delete with SHA checks), labels, issues, comments, pull
  requests, PR files, squash merge with 3-way conflict detection.
- **GraphQL v4** at `/api/graphql`: the documents `gh` and
  `github-mcp-server` send, plus introspection for `Issue`, `PullRequest`,
  `Repository` and `SearchType`.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, revision `2026-07-28`
  (`server/discover` + legacy `initialize` fallback), six tools —
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — sharing the REST store.

## Auth

`Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` on REST, GraphQL and MCP;
missing or wrong token is 401. A repo belongs to the token's login
(`adaiversen` in the harness scenario); the same repo name under another
owner is 404, never 403. Git smart-HTTP routes are unauthenticated, as the
harness expects.

## Determinism

Two runs produce byte-identical state exports: no wall clock, no randomness.
All timestamps come from a logical counter (epoch 2025-01-01T00:00:00Z plus a
sequence), ids from counters, and pack entries are sorted by object id.

## Layout

- `main.ts` — lifecycle only (register + done polling).
- `lib/app.ts` — HTTP server + routing.
- `lib/store.ts` — in-memory store (repos, objects, refs, issues, PRs).
- `lib/gitproto.ts` — pkt-lines, packfiles, git objects, reachability,
  shallow-fetch planning.
- `lib/git.ts` — git smart-HTTP handlers.
- `lib/rest.ts` — REST v3 handlers.
- `lib/graphql.ts` — GraphQL parser + executor.
- `lib/mcp.ts` — MCP handlers.
- `lib/scenario.ts` — harness scenario constants.
- `lib/util.ts` — shared helpers.
