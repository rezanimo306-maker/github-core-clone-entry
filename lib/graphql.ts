// GraphQL v4 executor for /api/graphql: a small tokenizer + recursive-descent
// parser and an executor over the store, covering exactly the documents the
// suite sends (gh + github-mcp-server shapes) plus introspection.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { b64decode, b64encode, bearerToken, isRecord, parseJsonBody, sendJson } from './util.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';
import { type Issue, type Pull, type Repo, type Store } from './store.ts';
import { buildTreeFromMap, flattenTree, makeCommit, parseCommit, peelObject, threeWay } from './gitproto.ts';
import { requestIdHeader } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldSel {
  kind: 'field';
  name: string;
  alias?: string;
  args: { name: string; value: ValueNode }[];
  selection?: Selection[];
}
interface SpreadSel {
  kind: 'spread';
  name: string;
}
interface InlineSel {
  kind: 'inline';
  typeCondition?: string;
  selection: Selection[];
}
type Selection = FieldSel | SpreadSel | InlineSel;

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: { name: string; type: string; defaultValue?: ValueNode }[];
  selection: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selection: Selection[] }>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc;
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j++;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j++;
        if (input[j] === '+' || input[j] === '-') j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of query');
    this.pos++;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected '${value}', got ${t.value}`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${t.value}`);
    if (value && t.value !== value) throw new Error(`expected '${value}', got ${t.value}`);
    return t.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', variables: [], selection: this.parseSelectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        const n = this.peek();
        if (n && n.kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        const selection = this.parseSelectionSet();
        operations.push({ kind, name, variables, selection });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selection });
      } else {
        throw new Error(`unexpected token ${t.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Operation['variables'] {
    const out: Operation['variables'] = [];
    const t = this.peek();
    if (!t || t.kind !== 'punct' || t.value !== '(') return out;
    this.next();
    while (true) {
      const n = this.peek();
      if (!n) throw new Error('unterminated variable definitions');
      if (n.kind === 'punct' && n.value === ')') {
        this.next();
        break;
      }
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      const eq = this.peek();
      if (eq && eq.kind === 'punct' && eq.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      out.push({ name, type, defaultValue });
    }
    return out;
  }

  private parseType(): string {
    const t = this.peek();
    if (!t) throw new Error('unterminated type');
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      const bang = this.peek();
      if (bang && bang.kind === 'punct' && bang.value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    const name = this.expectName();
    let out = name;
    const bang = this.peek();
    if (bang && bang.kind === 'punct' && bang.value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (true) {
      const t = this.peek();
      if (!t) throw new Error('unterminated selection set');
      if (t.kind === 'punct' && t.value === '}') {
        this.next();
        break;
      }
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): Selection {
    const t = this.peek()!;
    if (t.kind === 'spread') {
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (n && n.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | undefined;
    const colon = this.peek();
    if (colon && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selection: Selection[] | undefined;
    const brace = this.peek();
    if (brace && brace.kind === 'punct' && brace.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selection };
  }

  private skipDirectives(): void {
    while (true) {
      const t = this.peek();
      if (!t || t.kind !== 'punct' || t.value !== '@') return;
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const out: { name: string; value: ValueNode }[] = [];
    const t = this.peek();
    if (!t || t.kind !== 'punct' || t.value !== '(') return out;
    this.next();
    while (true) {
      const n = this.peek();
      if (!n) throw new Error('unterminated arguments');
      if (n.kind === 'punct' && n.value === ')') {
        this.next();
        break;
      }
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (true) {
        const n = this.peek();
        if (!n) throw new Error('unterminated list');
        if (n.kind === 'punct' && n.value === ']') {
          this.next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (true) {
        const n = this.peek();
        if (!n) throw new Error('unterminated object');
        if (n.kind === 'punct' && n.value === '}') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: Number.parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

export interface GqlContext {
  store: Store;
}

interface GqlValue {
  __typename: string;
  [key: string]: unknown;
}

type Resolver = (parent: GqlValue, args: Record<string, unknown>, ctx: GqlContext) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {};

function def(typeName: string, fields: Record<string, Resolver>): void {
  RESOLVERS[typeName] = fields;
}

function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64encode(`${kind}:${parts.join(':')}`);
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = b64decode(id);
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoValue(repo: Repo): GqlValue {
  return { __typename: 'Repository', repo };
}
function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', repo, issue };
}
function pullValue(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', repo, pull };
}
function userValue(login: string, id: number): GqlValue {
  return { __typename: 'User', login, id };
}

function cursorFor(index: number): string {
  return b64encode(`cursor:${index}`);
}
function indexFromCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const text = b64decode(cursor);
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number.parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

function connection<T>(items: T[], first: number | undefined, after: string | null | undefined): { nodes: T[]; pageInfo: GqlValue } {
  const start = indexFromCursor(after) + 1;
  const limit = first ?? items.length;
  const nodes = items.slice(start, start + limit);
  const end = start + nodes.length;
  return {
    nodes,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < items.length,
      endCursor: nodes.length > 0 ? cursorFor(end - 1) : null,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? cursorFor(start) : null,
    },
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullFiles(repo: Repo, pull: Pull): { path: string }[] {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return [];
  const headTree = flattenTree(repo, parseCommit(repo.objects.get(peelObject(repo, headTip))!.data).tree);
  const baseTree = flattenTree(repo, parseCommit(repo.objects.get(peelObject(repo, baseTip))!.data).tree);
  const paths = new Set([...headTree.keys(), ...baseTree.keys()]);
  const out: { path: string }[] = [];
  for (const path of [...paths].sort()) {
    const h = headTree.get(path);
    const b = baseTree.get(path);
    if ((h?.oid ?? null) !== (b?.oid ?? null)) out.push({ path });
  }
  return out;
}

function mergePullRequest(store: Store, repo: Repo, pull: Pull): void {
  if (pull.merged) return;
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) throw new Error('Pull request branches are missing');
  const { conflict, merged } = threeWay(repo, headTip, baseTip);
  if (conflict) throw new Error('Merge conflict');
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
}

def('Query', {
  viewer: () => userValue(VIEWER_LOGIN, VIEWER_ID),
  repository: (_p, args, ctx) => {
    const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return repo ? repoValue(repo) : null;
  },
  node: (_p, args, ctx) => {
    const decoded = decodeGlobalId(String(args.id ?? ''));
    if (!decoded) return null;
    const [a, b, c] = decoded.parts;
    if (decoded.kind === 'Repository') {
      for (const repo of ctx.store.repos.values()) {
        if (repo.id === Number(a)) return repoValue(repo);
      }
      return null;
    }
    if (decoded.kind === 'Issue') {
      for (const repo of ctx.store.repos.values()) {
        if (repo.id !== Number(a)) continue;
        const issue = repo.issues.find((i) => i.number === Number(b));
        return issue ? issueValue(repo, issue) : null;
      }
      return null;
    }
    if (decoded.kind === 'PullRequest') {
      for (const repo of ctx.store.repos.values()) {
        if (repo.id !== Number(a)) continue;
        const pull = repo.pulls.find((p) => p.number === Number(b));
        return pull ? pullValue(repo, pull) : null;
      }
      return null;
    }
    if (decoded.kind === 'IssueComment') {
      for (const repo of ctx.store.repos.values()) {
        if (repo.id !== Number(a)) continue;
        const issue = repo.issues.find((i) => i.number === Number(b));
        const comment = issue?.comments.find((cm) => cm.id === Number(c));
        return comment ? { __typename: 'IssueComment', id: comment.id, body: comment.body, repoId: repo.id, issueNumber: issue.number } : null;
      }
      return null;
    }
    return null;
  },
  __type: (_p, args) => introspectType(String(args.name ?? '')),
  __schema: () => ({ __typename: '__Schema', types: [] }),
});

def('Mutation', {
  createIssue: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository') throw new Error('repositoryId does not identify a repository');
    const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
    if (!repo) throw new Error('repository not found');
    const now = ctx.store.tick();
    const issue: Issue = {
      id: ctx.store.nextIssueId(),
      number: repo.nextNumber++,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
  },
  closeIssue: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'Issue') throw new Error('issueId does not identify an issue');
    for (const repo of ctx.store.repos.values()) {
      if (repo.id !== Number(decoded.parts[0])) continue;
      const issue = repo.issues.find((i) => i.number === Number(decoded.parts[1]));
      if (!issue) throw new Error('issue not found');
      issue.state = 'closed';
      issue.closedAt = ctx.store.tick();
      issue.updatedAt = issue.closedAt;
      return { __typename: 'CloseIssuePayload', issue: issueValue(repo, issue) };
    }
    throw new Error('issue not found');
  },
  createPullRequest: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository') throw new Error('repositoryId does not identify a repository');
    const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
    if (!repo) throw new Error('repository not found');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`head branch '${head}' does not exist`);
    if (!repo.refs.has(`refs/heads/${base}`)) throw new Error(`base branch '${base}' does not exist`);
    const now = ctx.store.tick();
    const pull: Pull = {
      id: ctx.store.nextIssueId(),
      number: repo.nextNumber++,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
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
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) };
  },
  mergePullRequest: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'PullRequest') throw new Error('pullRequestId does not identify a pull request');
    for (const repo of ctx.store.repos.values()) {
      if (repo.id !== Number(decoded.parts[0])) continue;
      const pull = repo.pulls.find((p) => p.number === Number(decoded.parts[1]));
      if (!pull) throw new Error('pull request not found');
      mergePullRequest(ctx.store, repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) };
    }
    throw new Error('pull request not found');
  },
  addComment: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'Issue') throw new Error('subjectId does not identify an issue');
    for (const repo of ctx.store.repos.values()) {
      if (repo.id !== Number(decoded.parts[0])) continue;
      const issue = repo.issues.find((i) => i.number === Number(decoded.parts[1]));
      if (!issue) throw new Error('issue not found');
      const now = ctx.store.tick();
      const comment = { id: ctx.store.nextCommentIdValue(), body: String(input.body ?? ''), createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: comment.id, body: comment.body, repoId: repo.id, issueNumber: issue.number },
          cursor: cursorFor(issue.comments.length - 1),
        },
      };
    }
    throw new Error('issue not found');
  },
});

def('Repository', {
  id: (p) => globalId('Repository', (p.repo as Repo).id),
  databaseId: (p) => (p.repo as Repo).id,
  name: (p) => (p.repo as Repo).name,
  nameWithOwner: (p) => `${(p.repo as Repo).owner}/${(p.repo as Repo).name}`,
  owner: (p) => userValue((p.repo as Repo).owner, (p.repo as Repo).owner === VIEWER_LOGIN ? VIEWER_ID : (p.repo as Repo).id),
  defaultBranchRef: (p) => ({ __typename: 'Ref', name: (p.repo as Repo).defaultBranch }),
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  description: (p) => (p.repo as Repo).description,
  isPrivate: (p) => (p.repo as Repo).private,
  url: (p) => `https://github.com/${(p.repo as Repo).owner}/${(p.repo as Repo).name}`,
  createdAt: (p) => (p.repo as Repo).createdAt,
  updatedAt: (p) => (p.repo as Repo).updatedAt,
  issue: (p, args) => {
    const repo = p.repo as Repo;
    const issue = repo.issues.find((i) => i.number === Number(args.number));
    return issue ? issueValue(repo, issue) : null;
  },
  issues: (p, args) => {
    const repo = p.repo as Repo;
    let items = [...repo.issues];
    const states = args.states as string[] | undefined;
    if (states && states.length > 0) {
      items = items.filter((i) => states.includes(issueState(i)));
    } else {
      items = items.filter((i) => i.state === 'open');
    }
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = String(orderBy.direction ?? 'ASC');
    items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
    const conn = connection(items.map((i) => issueValue(repo, i)), args.first as number | undefined, args.after as string | null | undefined);
    return { __typename: 'IssueConnection', nodes: conn.nodes, pageInfo: conn.pageInfo, totalCount: items.length };
  },
  pullRequests: (p, args) => {
    const repo = p.repo as Repo;
    let items = [...repo.pulls];
    const states = args.states as string[] | undefined;
    if (states && states.length > 0) {
      items = items.filter((pr) => states.includes(pullState(pr)));
    }
    items.sort((a, b) => a.number - b.number);
    const conn = connection(items.map((pr) => pullValue(repo, pr)), args.first as number | undefined, args.after as string | null | undefined);
    return { __typename: 'PullRequestConnection', nodes: conn.nodes, pageInfo: conn.pageInfo, totalCount: items.length };
  },
  pullRequest: (p, args) => {
    const repo = p.repo as Repo;
    const pull = repo.pulls.find((pr) => pr.number === Number(args.number));
    return pull ? pullValue(repo, pull) : null;
  },
});

def('Issue', {
  id: (p) => globalId('Issue', (p.repo as Repo).id, (p.issue as Issue).number),
  databaseId: (p) => (p.issue as Issue).id,
  number: (p) => (p.issue as Issue).number,
  title: (p) => (p.issue as Issue).title,
  body: (p) => (p.issue as Issue).body,
  state: (p) => issueState(p.issue as Issue),
  author: () => userValue(VIEWER_LOGIN, VIEWER_ID),
  createdAt: (p) => (p.issue as Issue).createdAt,
  updatedAt: (p) => (p.issue as Issue).updatedAt,
  closedAt: (p) => (p.issue as Issue).closedAt,
  url: (p) => `https://github.com/${(p.repo as Repo).owner}/${(p.repo as Repo).name}/issues/${(p.issue as Issue).number}`,
  repository: (p) => repoValue(p.repo as Repo),
  labels: (p) => ({ __typename: 'LabelConnection', nodes: (p.issue as Issue).labels.map((name) => ({ __typename: 'Label', name })) }),
  comments: (p) => ({
    __typename: 'IssueCommentConnection',
    nodes: (p.issue as Issue).comments.map((c) => ({ __typename: 'IssueComment', id: c.id, body: c.body, repoId: (p.repo as Repo).id, issueNumber: (p.issue as Issue).number })),
    totalCount: (p.issue as Issue).comments.length,
  }),
});

def('PullRequest', {
  id: (p) => globalId('PullRequest', (p.repo as Repo).id, (p.pull as Pull).number),
  databaseId: (p) => (p.pull as Pull).id,
  number: (p) => (p.pull as Pull).number,
  title: (p) => (p.pull as Pull).title,
  body: (p) => (p.pull as Pull).body,
  state: (p) => pullState(p.pull as Pull),
  merged: (p) => (p.pull as Pull).merged,
  mergeable: (p) => {
    const repo = p.repo as Repo;
    const pull = p.pull as Pull;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headTip || !baseTip) return 'UNKNOWN';
    return threeWay(repo, headTip, baseTip).conflict ? 'CONFLICTING' : 'MERGEABLE';
  },
  headRefName: (p) => (p.pull as Pull).head,
  baseRefName: (p) => (p.pull as Pull).base,
  headRef: (p) => ({ __typename: 'Ref', name: (p.pull as Pull).head }),
  baseRef: (p) => ({ __typename: 'Ref', name: (p.pull as Pull).base }),
  author: () => userValue(VIEWER_LOGIN, VIEWER_ID),
  createdAt: (p) => (p.pull as Pull).createdAt,
  updatedAt: (p) => (p.pull as Pull).updatedAt,
  mergedAt: (p) => (p.pull as Pull).mergedAt,
  files: (p, args) => {
    const files = pullFiles(p.repo as Repo, p.pull as Pull);
    const conn = connection(
      files.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path })),
      args.first as number | undefined,
      args.after as string | null | undefined,
    );
    return { __typename: 'PullRequestChangedFileConnection', nodes: conn.nodes, pageInfo: conn.pageInfo, totalCount: files.length };
  },
});

def('User', {
  login: (p) => String(p.login ?? ''),
  id: (p) => globalId('User', Number(p.id ?? 0)),
  databaseId: (p) => Number(p.id ?? 0),
  name: (p) => String(p.login ?? ''),
  email: () => 'adaiversen@example.invalid',
  url: (p) => `https://github.com/${String(p.login ?? '')}`,
});

def('Ref', {
  name: (p) => String(p.name ?? ''),
});

def('IssueConnection', {
  nodes: (p) => p.nodes,
  pageInfo: (p) => p.pageInfo,
  totalCount: (p) => Number(p.totalCount ?? 0),
});
def('PullRequestConnection', {
  nodes: (p) => p.nodes,
  pageInfo: (p) => p.pageInfo,
  totalCount: (p) => Number(p.totalCount ?? 0),
});
def('PullRequestChangedFileConnection', {
  nodes: (p) => p.nodes,
  pageInfo: (p) => p.pageInfo,
  totalCount: (p) => Number(p.totalCount ?? 0),
});
def('IssueCommentConnection', {
  nodes: (p) => p.nodes,
  totalCount: (p) => Number(p.totalCount ?? 0),
});
def('LabelConnection', {
  nodes: (p) => p.nodes,
  totalCount: (p) => Number(p.totalCount ?? 0),
});
def('PullRequestChangedFile', {
  path: (p) => String(p.path ?? ''),
  additions: () => 1,
  deletions: () => 0,
  changeType: () => 'MODIFIED',
});
def('IssueComment', {
  id: (p) => {
    const repoId = typeof p.repoId === 'number' ? p.repoId : 0;
    const issueNumber = typeof p.issueNumber === 'number' ? p.issueNumber : 0;
    return globalId('IssueComment', repoId, issueNumber, Number(p.id ?? 0));
  },
  databaseId: (p) => Number(p.id ?? 0),
  body: (p) => String(p.body ?? ''),
  author: () => userValue(VIEWER_LOGIN, VIEWER_ID),
  createdAt: () => '2025-01-01T00:00:00.000Z',
  updatedAt: () => '2025-01-01T00:00:00.000Z',
});
def('Label', {
  name: (p) => String(p.name ?? ''),
});
def('PageInfo', {
  hasNextPage: (p) => Boolean(p.hasNextPage),
  hasPreviousPage: (p) => Boolean(p.hasPreviousPage),
  startCursor: (p) => (p.startCursor as string | null) ?? null,
  endCursor: (p) => (p.endCursor as string | null) ?? null,
});
def('CreateIssuePayload', { issue: (p) => p.issue });
def('CloseIssuePayload', { issue: (p) => p.issue });
def('CreatePullRequestPayload', { pullRequest: (p) => p.pullRequest });
def('MergePullRequestPayload', { pullRequest: (p) => p.pullRequest });
def('AddCommentPayload', { commentEdge: (p) => p.commentEdge });
def('IssueCommentEdge', {
  node: (p) => p.node,
  cursor: (p) => String(p.cursor ?? ''),
});
def('__Schema', {
  types: () => [],
  queryType: () => ({ __typename: '__Type', name: 'Query' }),
  mutationType: () => ({ __typename: '__Type', name: 'Mutation' }),
});

// ---------------------------------------------------------------------------------------------
// introspection
// ---------------------------------------------------------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'labels', 'comments'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt'],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'databaseId', 'name', 'email', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  __Type: { kind: 'OBJECT', fields: ['kind', 'name', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'] },
};

function introspectType(name: string): GqlValue | null {
  const defn = TYPE_DEFS[name];
  if (!defn) return null;
  return {
    __typename: '__Type',
    name,
    kind: defn.kind,
    fields: (defn.fields ?? []).map((f) => ({ __typename: '__Field', name: f, description: null, args: [], isDeprecated: false, deprecationReason: null })),
    enumValues: (defn.enumValues ?? []).map((v) => ({ __typename: '__EnumValue', name: v, description: null, isDeprecated: false, deprecationReason: null })),
    inputFields: [],
    interfaces: [],
    possibleTypes: [],
  };
}

def('__Type', {
  kind: (p) => String(p.kind ?? ''),
  name: (p) => String(p.name ?? ''),
  description: () => null,
  fields: (p) => (p.fields as unknown[]) ?? [],
  enumValues: (p) => (p.enumValues as unknown[]) ?? [],
  inputFields: () => [],
  interfaces: () => [],
  possibleTypes: () => [],
});
def('__Field', {
  name: (p) => String(p.name ?? ''),
  description: () => null,
  args: () => [],
  type: () => ({ __typename: '__Type', name: 'String', kind: 'SCALAR' }),
  isDeprecated: () => false,
  deprecationReason: () => null,
});
def('__EnumValue', {
  name: (p) => String(p.name ?? ''),
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
});
def('__InputValue', {
  name: (p) => String(p.name ?? ''),
  description: () => null,
  type: () => ({ __typename: '__Type', name: 'String', kind: 'SCALAR' }),
  defaultValue: () => null,
});

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: { name: string; value: ValueNode }[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

class GraphQLError extends Error {}

function executeSelection(
  parent: GqlValue,
  selections: Selection[],
  ctx: GqlContext,
  variables: Record<string, unknown>,
  doc: Document,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = doc.fragments.get(sel.name);
      if (!frag) throw new GraphQLError(`Unknown fragment "${sel.name}"`);
      Object.assign(out, executeSelection(parent, frag.selection, ctx, variables, doc));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelection(parent, sel.selection, ctx, variables, doc));
      continue;
    }
    const fieldName = sel.name;
    const responseKey = sel.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = parent.__typename;
      continue;
    }
    const typeResolvers = RESOLVERS[parent.__typename];
    const resolver = typeResolvers?.[fieldName];
    if (!resolver) {
      throw new GraphQLError(`Cannot query field "${fieldName}" on type "${parent.__typename}".`);
    }
    const args = resolveArgs(sel.args, variables);
    const value = resolver(parent, args, ctx);
    out[responseKey] = completeValue(value, sel.selection, ctx, variables, doc);
  }
  return out;
}

function completeValue(
  value: unknown,
  selection: Selection[] | undefined,
  ctx: GqlContext,
  variables: Record<string, unknown>,
  doc: Document,
): unknown {
  if (value === null || value === undefined) return null;
  if (!selection) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object') return executeSelection(item as GqlValue, selection, ctx, variables, doc);
      return item;
    });
  }
  if (typeof value === 'object') {
    return executeSelection(value as GqlValue, selection, ctx, variables, doc);
  }
  return value;
}

function executeOperation(doc: Document, op: Operation, variables: Record<string, unknown>, ctx: GqlContext): { data?: unknown; errors?: { message: string }[] } {
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const vars: Record<string, unknown> = {};
  for (const v of op.variables) {
    if (variables[v.name] !== undefined) vars[v.name] = variables[v.name];
    else if (v.defaultValue) vars[v.name] = resolveValue(v.defaultValue, {});
    else vars[v.name] = null;
  }
  try {
    const data = executeSelection({ __typename: rootType }, op.selection, ctx, vars, doc);
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: GqlContext, shopToken: string, body: Buffer): void {
  const token = bearerToken(req);
  if (!token || (shopToken && token !== shopToken)) {
    sendJson(res, 401, { message: 'Bad credentials' }, requestIdHeader());
    return;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { message: parsed.error }, requestIdHeader());
    return;
  }
  const value = parsed.value;
  const isBatch = Array.isArray(value);
  const requests = isBatch ? value : [value];
  const results: unknown[] = [];
  for (const item of requests) {
    if (!isRecord(item) || typeof item.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'query is required' }] });
      continue;
    }
    let doc: Document;
    try {
      doc = new Parser(tokenize(item.query)).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
      continue;
    }
    if (doc.operations.length === 0) {
      results.push({ data: null, errors: [{ message: 'no operation found' }] });
      continue;
    }
    const op = doc.operations.find((o) => o.name === item.operationName) ?? doc.operations[0];
    const variables = isRecord(item.variables) ? (item.variables as Record<string, unknown>) : {};
    results.push(executeOperation(doc, op, variables, ctx));
  }
  sendJson(res, 200, isBatch ? results : results[0], requestIdHeader());
}
