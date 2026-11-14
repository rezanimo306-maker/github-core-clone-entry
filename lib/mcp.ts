// MCP (Model Context Protocol) over Streamable HTTP at /mcp:
// JSON-RPC 2.0, revision 2026-07-28 (with the 2025-11-25 legacy handshake),
// six tools sharing the same store as REST.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken, isRecord, sendJson } from './util.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';
import { type Issue, type Pull, type Repo, type Store } from './store.ts';
import { buildTreeFromMap, makeCommit, peelObject, threeWay } from './gitproto.ts';
import { requestIdHeader } from './rest.ts';

export interface McpContext {
  store: Store;
  shopToken: string;
}

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

// Built once and reused so tools/list is byte-identical across calls.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoObject(repo: Repo): Record<string, unknown> {
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
    html_url: `/${repo.owner}/${repo.name}`,
    has_issues: true,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
  };
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.head, sha: repo.refs.get(`refs/heads/${pull.head}`) ?? null },
    base: { ref: pull.base, sha: repo.refs.get(`refs/heads/${pull.base}`) ?? null },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function toolResult(obj: Record<string, unknown>): { content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown> } {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireArgs(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      return `Missing required argument: ${name}`;
    }
  }
  return null;
}

function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: true } {
  const store = ctx.store;
  switch (name) {
    case 'create_repo': {
      const missing = requireArgs(args, ['name']);
      if (missing) return toolError(missing);
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName)) return toolError('Repository already exists');
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult(repoObject(repo));
    }
    case 'get_repo': {
      const missing = requireArgs(args, ['owner', 'repo']);
      if (missing) return toolError(missing);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError('Repository not found');
      return toolResult(repoObject(repo));
    }
    case 'create_issue': {
      const missing = requireArgs(args, ['owner', 'repo', 'title']);
      if (missing) return toolError(missing);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError('Repository not found');
      const now = store.tick();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      return toolResult(issueObject(repo, issue));
    }
    case 'list_issues': {
      const missing = requireArgs(args, ['owner', 'repo']);
      if (missing) return toolError(missing);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => a.number - b.number)
        .map((i) => issueObject(repo, i));
      return toolResult({ issues: items });
    }
    case 'create_pull_request': {
      const missing = requireArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing) return toolError(missing);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError('Repository not found');
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`head branch '${head}' does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`base branch '${base}' does not exist`);
      const duplicate = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (duplicate) return toolError('A pull request already exists for this head and base');
      const now = store.tick();
      const pull: Pull = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.push(pull);
      return toolResult(pullObject(repo, pull));
    }
    case 'merge_pull_request': {
      const missing = requireArgs(args, ['owner', 'repo', 'pull_number']);
      if (missing) return toolError(missing);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError('Repository not found');
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return toolError('Pull request not found');
      if (pull.merged) return toolResult({ merged: true, number: pull.number, sha: pull.mergeCommitSha });
      if (pull.state !== 'open') return toolError('Pull request is closed');
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      if (!headTip || !baseTip) return toolError('Pull request branches are missing');
      const { conflict, merged } = threeWay(repo, headTip, baseTip);
      if (conflict) return toolError('Merge conflict');
      const treeOid = buildTreeFromMap(store, repo, merged);
      const ts = store.tickSeconds();
      const who = `Conformance <conformance@make.fun> ${ts} +0000`;
      const message = `Merge pull request #${pull.number} from ${pull.head}`;
      const commitOid = store.putObject(repo, 'commit', makeCommit(treeOid, [peelObject(repo, baseTip)], who, who, message));
      repo.refs.set(`refs/heads/${pull.base}`, commitOid);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = commitOid;
      pull.mergedAt = store.tick();
      pull.updatedAt = pull.mergedAt;
      return toolResult({ merged: true, number: pull.number, sha: commitOid, message });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: McpContext, body: Buffer): void {
  const respond = (status: number, payload: unknown): void => {
    sendJson(res, status, payload, requestIdHeader());
  };
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    respond(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(request)) {
    respond(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';

  // Notifications carry no id: acknowledge with 202 and an empty body.
  if (id === undefined) {
    res.writeHead(202, { 'content-length': '0', ...requestIdHeader() });
    res.end();
    return;
  }

  // Auth is decided before any tool exists.
  const token = bearerToken(req);
  if (!token || (ctx.shopToken && token !== ctx.shopToken)) {
    respond(401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }

  const params = isRecord(request.params) ? (request.params as Record<string, unknown>) : {};
  const result = (value: unknown): void => respond(200, { jsonrpc: '2.0', id, result: value });
  const error = (code: number, message: string): void =>
    respond(200, { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover': {
      result({
        supportedVersions: SUPPORTED_REVISIONS,
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = SUPPORTED_REVISIONS.includes(offered) ? offered : '2025-11-25';
      result({
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case 'ping': {
      result({});
      return;
    }
    case 'tools/list': {
      result({ tools: TOOLS });
      return;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const known = TOOLS.some((t) => t.name === toolName);
      if (!known) {
        error(-32602, `Unknown tool: ${toolName}`);
        return;
      }
      const missing = requireArgs(args, TOOLS.find((t) => t.name === toolName)!.inputSchema.required);
      if (missing) {
        error(-32602, missing);
        return;
      }
      result(callTool(ctx, toolName, args));
      return;
    }
    default: {
      error(-32601, `Method not found: ${method}`);
      return;
    }
  }
}
