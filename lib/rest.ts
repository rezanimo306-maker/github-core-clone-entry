// REST v3 handlers under /api/v3: repos, issues, PRs, contents, git refs.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  b64decodeBytes,
  bearerToken,
  isRecord,
  linkHeader,
  parseJsonBody,
  queryInt,
  sendJson,
  sendJsonError,
  sendNoContent,
} from './util.ts';
import {
  COMMIT_AUTHOR,
  COMMIT_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
} from './scenario.ts';
import {
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
  ZERO_OID,
} from './store.ts';
import {
  buildTreeFromMap,
  flattenTree,
  isAncestor,
  listCommits,
  makeCommit,
  mergeBase,
  parseCommit,
  parseTree,
  peelObject,
  threeWay,
} from './gitproto.ts';

export interface RestContext {
  store: Store;
  shopToken: string;
}

const JSON_HEADERS = (req: IncomingMessage, extra?: Record<string, string>): Record<string, string> => ({
  'X-GitHub-Request-Id': `req-${String(++requestSeq).padStart(6, '0')}`,
  ...extra,
});

// Request-id counter lives here (one per process, deterministic order).
let requestSeq = 0;

export function requestIdHeader(): Record<string, string> {
  return { 'X-GitHub-Request-Id': `req-${String(++requestSeq).padStart(6, '0')}` };
}

function ok(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  sendJson(res, status, body, { ...requestIdHeader(), ...extra });
}

function fail(req: IncomingMessage, res: ServerResponse, status: number, message: string, extra?: Record<string, string>): void {
  sendJsonError(res, status, message, { ...requestIdHeader(), ...extra });
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!m) return { name: line, email: '', date: '' };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

function repoObject(req: IncomingMessage, repo: Repo): Record<string, unknown> {
  const base = `http://${req.headers.host ?? 'localhost'}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : repo.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelObject(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '', default: false };
}

function issueObject(req: IncomingMessage, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `http://${req.headers.host ?? 'localhost'}`;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((l) => l.name === name);
      return found ? labelObject(found) : { name, color: '000000' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function pullObject(req: IncomingMessage, repo: Repo, pull: Pull): Record<string, unknown> {
  const base = `http://${req.headers.host ?? 'localhost'}`;
  const headSha = branchTip(repo, pull.head);
  const baseSha = branchTip(repo, pull.base);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: computeMergeable(repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.head, sha: headSha ?? null, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha ?? null, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Three-way merge conflict test for a pull request. */
export function computeMergeable(repo: Repo, pull: Pull): boolean {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (!headTip || !baseTip) return false;
  return threeWay(repo, headTip, baseTip).conflict === false;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Multiset line diff: lines in new not in old count as additions, and vice versa. */
function lineDiff(oldBuf: Buffer, newBuf: Buffer): { additions: number; deletions: number } {
  const oldLines = oldBuf.length === 0 ? [] : oldBuf.toString('utf8').split('\n');
  const newLines = newBuf.length === 0 ? [] : newBuf.toString('utf8').split('\n');
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const n = oldCount.get(line) ?? 0;
    if (n > 0) oldCount.set(line, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of oldCount.values()) deletions += n;
  return { additions, deletions };
}

function createCommitForContents(store: Store, repo: Repo, branch: string, message: string, mutate: (files: Map<string, { oid: string; mode: string }>) => void): string {
  const tip = branchTip(repo, branch);
  const files = new Map<string, { oid: string; mode: string }>();
  if (tip) {
    const commit = parseCommit(repo.objects.get(peelObject(repo, tip))!.data);
    for (const [path, file] of flattenTree(repo, commit.tree)) files.set(path, file);
  }
  mutate(files);
  const treeOid = buildTreeFromMap(store, repo, files);
  const ts = store.tickSeconds();
  const who = `${COMMIT_AUTHOR} ${ts} +0000`;
  const parents = tip ? [peelObject(repo, tip)] : [];
  const data = makeCommit(treeOid, parents, who, who, message);
  const commitOid = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

function paginate<T>(items: T[], search: URLSearchParams): { page: T[]; hasNext: boolean; pageNum: number; perPage: number } {
  const perPage = queryInt(search, 'per_page', 30);
  const pageNum = queryInt(search, 'page', 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length, pageNum, perPage };
}

/** Main REST dispatcher. Returns true when the request was handled. */
export function handleRest(req: IncomingMessage, res: ServerResponse, ctx: RestContext, segments: string[], search: URLSearchParams, body: Buffer): boolean {
  // Auth: every /api/v3 route requires the configured Bearer token.
  const token = bearerToken(req);
  if (!token || (ctx.shopToken && token !== ctx.shopToken)) {
    fail(req, res, 401, 'Bad credentials');
    return true;
  }
  const store = ctx.store;
  const method = req.method ?? 'GET';
  const parsed = parseJsonBody(body);

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return fail(req, res, 405, 'Method Not Allowed'), true;
    return ok(req, res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    }, { 'X-OAuth-Scopes': 'repo, read:org' }), true;
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return fail(req, res, 405, 'Method Not Allowed'), true;
    return ok(req, res, 200, { installed_version: '1.0.0' }), true;
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return fail(req, res, 405, 'Method Not Allowed'), true;
    return ok(req, res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      type: 'User',
      name: VIEWER_LOGIN,
      email: 'adaiversen@example.invalid',
      html_url: `http://${req.headers.host ?? 'localhost'}/${VIEWER_LOGIN}`,
    }), true;
  }

  // POST /api/v3/user/repos and GET /api/v3/user/repos
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = store.listReposByOwner(VIEWER_LOGIN);
      const { page, hasNext, pageNum, perPage } = paginate(repos, search);
      const link = linkHeader(req, pageNum, perPage, hasNext);
      return ok(req, res, 200, page.map((r) => repoObject(req, r)), link ? { Link: link } : undefined), true;
    }
    if (method !== 'POST') return fail(req, res, 405, 'Method Not Allowed'), true;
    if (!parsed.ok) return fail(req, res, 400, parsed.error), true;
    const value = parsed.value;
    if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0) {
      return fail(req, res, 422, 'name is required'), true;
    }
    if (store.getRepo(VIEWER_LOGIN, value.name)) {
      return fail(req, res, 422, 'Repository already exists'), true;
    }
    const repo = store.createRepo(
      VIEWER_LOGIN,
      value.name,
      typeof value.description === 'string' ? value.description : '',
      value.private === true,
    );
    return ok(req, res, 201, repoObject(req, repo)), true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1]);
    const repoName = decodeURIComponent(segments[2]);
    const repo = store.getRepo(owner, repoName);
    const rest = segments.slice(3);
    if (!repo) return fail(req, res, 404, 'Not Found'), true;

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return ok(req, res, 200, repoObject(req, repo)), true;
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        res.writeHead(204, { 'content-length': '0', ...requestIdHeader() });
        res.end();
        return true;
      }
      if (method === 'PATCH') {
        if (!parsed.ok) return fail(req, res, 400, parsed.error), true;
        const value = parsed.value;
        if (isRecord(value)) {
          if (typeof value.description === 'string') repo.description = value.description;
          if (typeof value.private === 'boolean') repo.private = value.private;
          if (typeof value.default_branch === 'string') repo.defaultBranch = value.default_branch;
        }
        repo.updatedAt = store.tick();
        return ok(req, res, 200, repoObject(req, repo)), true;
      }
      return fail(req, res, 405, 'Method Not Allowed'), true;
    }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! }, protected: false }));
        return ok(req, res, 200, branches), true;
      }
      if (rest.length === 2 && method === 'GET') {
        const name = decodeURIComponent(rest[1]);
        const tip = branchTip(repo, name);
        if (!tip) return fail(req, res, 404, 'Branch not found'), true;
        return ok(req, res, 200, { name, commit: { sha: tip }, protected: false }), true;
      }
      return fail(req, res, 404, 'Not Found'), true;
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        if (!parsed.ok) return fail(req, res, 400, parsed.error), true;
        const value = parsed.value;
        if (!isRecord(value) || typeof value.ref !== 'string' || typeof value.sha !== 'string') {
          return fail(req, res, 422, 'ref and sha are required'), true;
        }
        if (repo.refs.has(value.ref)) return fail(req, res, 422, 'Reference already exists'), true;
        if (!repo.objects.has(value.sha)) return fail(req, res, 422, 'Invalid SHA'), true;
        repo.refs.set(value.ref, value.sha);
        return ok(req, res, 201, { ref: value.ref, object: { sha: value.sha, type: 'commit', url: '' } }), true;
      }
      if (rest.length >= 3 && method === 'GET') {
        const refName = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
        const oid = repo.refs.get(refName);
        if (!oid) return fail(req, res, 404, 'Not Found'), true;
        return ok(req, res, 200, { ref: refName, object: { sha: oid, type: 'commit', url: '' } }), true;
      }
      return fail(req, res, 404, 'Not Found'), true;
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = search.get('sha');
      const tip = shaParam ? (repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : undefined)) : branchTip(repo, repo.defaultBranch);
      if (!tip) return ok(req, res, 200, []), true;
      const oids = listCommits(repo, tip);
      const items = oids.map((oid) => {
        const c = parseCommit(repo.objects.get(oid)!.data);
        return {
          sha: oid,
          commit: {
            message: c.message,
            author: parseIdentity(c.author),
            committer: parseIdentity(c.committer),
            tree: { sha: c.tree },
          },
          author: { login: VIEWER_LOGIN },
          committer: { login: VIEWER_LOGIN },
        };
      });
      const { page, hasNext, pageNum, perPage } = paginate(items, search);
      const link = linkHeader(req, pageNum, perPage, hasNext);
      return ok(req, res, 200, page, link ? { Link: link } : undefined), true;
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const refParam = search.get('ref');
        const tip = refParam ? (repo.refs.get(`refs/heads/${refParam}`) ?? (repo.objects.has(refParam) ? refParam : undefined)) : branchTip(repo, repo.defaultBranch);
        if (!tip) return fail(req, res, 404, 'Not Found'), true;
        const commit = parseCommit(repo.objects.get(peelObject(repo, tip))!.data);
        const files = flattenTree(repo, commit.tree);
        if (path === '') {
          // root listing
          const entries: Record<string, unknown>[] = [];
          const seenDirs = new Set<string>();
          for (const [p, file] of files) {
            const slash = p.indexOf('/');
            if (slash === -1) {
              entries.push({ type: 'file', name: p, path: p, sha: file.oid, size: repo.objects.get(file.oid)?.data.length ?? 0 });
            } else {
              const dir = p.slice(0, slash);
              if (!seenDirs.has(dir)) {
                seenDirs.add(dir);
                entries.push({ type: 'dir', name: dir, path: dir, sha: '' });
              }
            }
          }
          entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
          return ok(req, res, 200, entries), true;
        }
        const file = files.get(path);
        if (file) {
          const blob = repo.objects.get(file.oid);
          return ok(req, res, 200, {
            type: 'file',
            encoding: 'base64',
            size: blob?.data.length ?? 0,
            name: path.split('/').pop(),
            path,
            content: blob ? blob.data.toString('base64') : '',
            sha: file.oid,
          }), true;
        }
        // directory listing?
        const prefix = `${path}/`;
        const entries: Record<string, unknown>[] = [];
        const seenDirs = new Set<string>();
        for (const [p, f] of files) {
          if (!p.startsWith(prefix)) continue;
          const rest2 = p.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash === -1) {
            entries.push({ type: 'file', name: rest2, path: p, sha: f.oid, size: repo.objects.get(f.oid)?.data.length ?? 0 });
          } else {
            const dir = rest2.slice(0, slash);
            if (!seenDirs.has(dir)) {
              seenDirs.add(dir);
              entries.push({ type: 'dir', name: dir, path: `${path}/${dir}`, sha: '' });
            }
          }
        }
        if (entries.length === 0) return fail(req, res, 404, 'Not Found'), true;
        entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return ok(req, res, 200, entries), true;
      }
      if (method === 'PUT' || method === 'DELETE') {
        if (!parsed.ok) return fail(req, res, 400, parsed.error), true;
        const value = parsed.value;
        if (!isRecord(value) || typeof value.message !== 'string') {
          return fail(req, res, 422, 'message is required'), true;
        }
        const branch = typeof value.branch === 'string' ? value.branch : repo.defaultBranch;
        let tip = branchTip(repo, branch);
        if (!tip && branch !== repo.defaultBranch) {
          // PUT with a new branch creates it from the current default tip.
          const defaultTip = branchTip(repo, repo.defaultBranch);
          if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
          tip = branchTip(repo, branch);
        }
        const files = new Map<string, { oid: string; mode: string }>();
        if (tip) {
          const commit = parseCommit(repo.objects.get(peelObject(repo, tip))!.data);
          for (const [p, f] of flattenTree(repo, commit.tree)) files.set(p, f);
        }
        const existing = files.get(path);
        if (method === 'PUT') {
          if (typeof value.content !== 'string') return fail(req, res, 422, 'content is required'), true;
          const bytes = b64decodeBytes(value.content);
          if (existing && typeof value.sha !== 'string') return fail(req, res, 422, 'sha is required to update a file'), true;
          if (existing && value.sha !== existing.oid) return fail(req, res, 409, 'sha does not match'), true;
          const isUpdate = Boolean(existing);
          const blobOid = store.putObject(repo, 'blob', bytes);
          const commitOid = createCommitForContents(store, repo, branch, value.message, (m) => {
            m.set(path, { oid: blobOid, mode: '100644' });
          });
          return ok(req, res, isUpdate ? 200 : 201, {
            content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, encoding: 'base64' },
            commit: { sha: commitOid, message: value.message },
          }), true;
        }
        // DELETE
        if (!existing) return fail(req, res, 404, 'Not Found'), true;
        if (typeof value.sha !== 'string' || value.sha !== existing.oid) return fail(req, res, 409, 'sha does not match'), true;
        const commitOid = createCommitForContents(store, repo, branch, value.message, (m) => {
          m.delete(path);
        });
        return ok(req, res, 200, { commit: { sha: commitOid, message: value.message } }), true;
      }
      return fail(req, res, 405, 'Method Not Allowed'), true;
    }

    // labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') return ok(req, res, 200, repo.labels.map(labelObject)), true;
      if (method === 'POST') {
        if (!parsed.ok) return fail(req, res, 400, parsed.error), true;
        const value = parsed.value;
        if (!isRecord(value) || typeof value.name !== 'string') return fail(req, res, 422, 'name is required'), true;
        if (repo.labels.some((l) => l.name === value.name)) return fail(req, res, 422, 'Label already exists'), true;
        const label: Label = { name: value.name, color: typeof value.color === 'string' ? value.color.replace(/^#/, '') : '000000' };
        repo.labels.push(label);
        return ok(req, res, 201, labelObject(label)), true;
      }
      return fail(req, res, 405, 'Method Not Allowed'), true;
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          let items = repo.issues.filter((i) => state === 'all' || i.state === state);
          const direction = search.get('direction') ?? 'asc';
          items = [...items].sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
          const { page, hasNext, pageNum, perPage } = paginate(items, search);
          const link = linkHeader(req, pageNum, perPage, hasNext);
          return ok(req, res, 200, page.map((i) => issueObject(req, repo, i)), link ? { Link: link } : undefined), true;
        }
        if (method === 'POST') {
          if (!parsed.ok) return fail(req, res, 400, parsed.error), true;
          const value = parsed.value;
          if (!isRecord(value) || typeof value.title !== 'string') return fail(req, res, 422, 'title is required'), true;
          const labelNames: string[] = Array.isArray(value.labels) ? value.labels.filter((l): l is string => typeof l === 'string') : [];
          for (const name of labelNames) {
            if (!repo.labels.some((l) => l.name === name)) return fail(req, res, 422, `Label '${name}' does not exist`), true;
          }
          const now = store.tick();
          const issue: Issue = {
            id: store.nextIssueId(),
            number: repo.nextNumber++,
            title: value.title,
            body: typeof value.body === 'string' ? value.body : '',
            state: 'open',
            labels: labelNames,
            comments: [],
            createdAt: now,
            updatedAt: now,
            closedAt: null,
          };
          repo.issues.push(issue);
          return ok(req, res, 201, issueObject(req, repo, issue)), true;
        }
        return fail(req, res, 405, 'Method Not Allowed'), true;
      }
      const num = Number.parseInt(rest[1], 10);
      if (Number.isNaN(num)) return fail(req, res, 404, 'Not Found'), true;
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return fail(req, res, 404, 'Not Found'), true;
      if (rest.length === 2) {
        if (method === 'GET') return ok(req, res, 200, issueObject(req, repo, issue)), true;
        if (method === 'PATCH') {
          if (!parsed.ok) return fail(req, res, 400, parsed.error), true;
          const value = parsed.value;
          if (isRecord(value)) {
            if (typeof value.title === 'string') issue.title = value.title;
            if (typeof value.body === 'string') issue.body = value.body;
            if (value.state === 'closed' || value.state === 'open') {
              issue.state = value.state;
              issue.closedAt = value.state === 'closed' ? store.tick() : null;
            }
          }
          issue.updatedAt = store.tick();
          return ok(req, res, 200, issueObject(req, repo, issue)), true;
        }
        return fail(req, res, 405, 'Method Not Allowed'), true;
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') {
          return ok(req, res, 200, issue.comments.map((c) => ({
            id: c.id,
            body: c.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: c.createdAt,
            updated_at: c.updatedAt,
          }))), true;
        }
        if (method === 'POST') {
          if (!parsed.ok) return fail(req, res, 400, parsed.error), true;
          const value = parsed.value;
          if (!isRecord(value) || typeof value.body !== 'string') return fail(req, res, 422, 'body is required'), true;
          const now = store.tick();
          const comment = { id: store.nextCommentIdValue(), body: value.body, createdAt: now, updatedAt: now };
          issue.comments.push(comment);
          return ok(req, res, 201, {
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
          }), true;
        }
        return fail(req, res, 405, 'Method Not Allowed'), true;
      }
      return fail(req, res, 404, 'Not Found'), true;
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          let items = repo.pulls.filter((p) => state === 'all' || p.state === state);
          items = [...items].sort((a, b) => a.number - b.number);
          const { page, hasNext, pageNum, perPage } = paginate(items, search);
          const link = linkHeader(req, pageNum, perPage, hasNext);
          return ok(req, res, 200, page.map((p) => pullObject(req, repo, p)), link ? { Link: link } : undefined), true;
        }
        if (method === 'POST') {
          if (!parsed.ok) return fail(req, res, 400, parsed.error), true;
          const value = parsed.value;
          if (!isRecord(value) || typeof value.head !== 'string' || typeof value.base !== 'string') {
            return fail(req, res, 422, 'head and base are required'), true;
          }
          if (!branchTip(repo, value.head)) return fail(req, res, 422, `head branch '${value.head}' does not exist`), true;
          if (!branchTip(repo, value.base)) return fail(req, res, 422, `base branch '${value.base}' does not exist`), true;
          const duplicate = repo.pulls.find((p) => p.state === 'open' && p.head === value.head && p.base === value.base);
          if (duplicate) return fail(req, res, 422, 'A pull request already exists for this head and base'), true;
          const now = store.tick();
          const pull: Pull = {
            id: store.nextIssueId(),
            number: repo.nextNumber++,
            title: typeof value.title === 'string' ? value.title : '',
            body: typeof value.body === 'string' ? value.body : '',
            head: value.head,
            base: value.base,
            state: 'open',
            merged: false,
            mergeCommitSha: null,
            mergedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          repo.pulls.push(pull);
          return ok(req, res, 201, pullObject(req, repo, pull)), true;
        }
        return fail(req, res, 405, 'Method Not Allowed'), true;
      }
      const num = Number.parseInt(rest[1], 10);
      if (Number.isNaN(num)) return fail(req, res, 404, 'Not Found'), true;
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return fail(req, res, 404, 'Not Found'), true;
      if (rest.length === 2 && method === 'GET') {
        return ok(req, res, 200, pullObject(req, repo, pull)), true;
      }
      if (rest[2] === 'files' && rest.length === 3 && method === 'GET') {
        const headTip = branchTip(repo, pull.head);
        const baseTip = branchTip(repo, pull.base);
        if (!headTip || !baseTip) return fail(req, res, 404, 'Not Found'), true;
        const headTree = flattenTree(repo, parseCommit(repo.objects.get(peelObject(repo, headTip))!.data).tree);
        const baseTree = flattenTree(repo, parseCommit(repo.objects.get(peelObject(repo, baseTip))!.data).tree);
        const files: Record<string, unknown>[] = [];
        const paths = new Set([...headTree.keys(), ...baseTree.keys()]);
        for (const path of [...paths].sort()) {
          const h = headTree.get(path);
          const b = baseTree.get(path);
          if (h && !b) {
            const additions = countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
            files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
          } else if (!h && b) {
            const deletions = countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
            files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
          } else if (h && b && h.oid !== b.oid) {
            const { additions, deletions } = lineDiff(
              repo.objects.get(b.oid)?.data ?? Buffer.alloc(0),
              repo.objects.get(h.oid)?.data ?? Buffer.alloc(0),
            );
            files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
          }
        }
        return ok(req, res, 200, files), true;
      }
      if (rest[2] === 'merge' && rest.length === 3 && method === 'PUT') {
        if (pull.merged) {
          return ok(req, res, 200, { merged: true, sha: pull.mergeCommitSha, message: `Pull request #${pull.number} already merged` }), true;
        }
        if (pull.state !== 'open') return fail(req, res, 405, 'Pull request is closed'), true;
        const headTip = branchTip(repo, pull.head);
        const baseTip = branchTip(repo, pull.base);
        if (!headTip || !baseTip) return fail(req, res, 404, 'Not Found'), true;
        const { conflict, merged } = threeWay(repo, headTip, baseTip);
        if (conflict) return fail(req, res, 405, 'Merge conflict'), true;
        const treeOid = buildTreeFromMap(store, repo, merged);
        const ts = store.tickSeconds();
        const who = `${COMMIT_AUTHOR} ${ts} +0000`;
        const message = `Merge pull request #${pull.number} from ${pull.head}`;
        const commitOid = store.putObject(repo, 'commit', makeCommit(treeOid, [peelObject(repo, baseTip)], who, who, message));
        repo.refs.set(`refs/heads/${pull.base}`, commitOid);
        pull.merged = true;
        pull.state = 'closed';
        pull.mergeCommitSha = commitOid;
        pull.mergedAt = store.tick();
        pull.updatedAt = pull.mergedAt;
        return ok(req, res, 200, { merged: true, sha: commitOid, message }), true;
      }
      return fail(req, res, 404, 'Not Found'), true;
    }
  }

  return false;
}
