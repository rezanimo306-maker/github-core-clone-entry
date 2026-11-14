// Git smart-HTTP handlers: info/refs (upload-pack v2/v0, receive-pack v0),
// upload-pack v2 (ls-refs, fetch), receive-pack v0 (push with report-status).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VERSION } from './util.ts';
import {
  ZERO_OID,
  type Repo,
  type Store,
} from './store.ts';
import {
  DELIM,
  FLUSH,
  buildTreeFromMap,
  closure,
  decodePktLines,
  flattenTree,
  isAncestor,
  makeCommit,
  parseCommit,
  parseTag,
  parseTree,
  peelObject,
  planFetch,
  pktLine,
  readPack,
  readPktBlock,
  writePack,
} from './gitproto.ts';

export interface GitContext {
  store: Store;
}

const UPLOAD_V2_CAPS = [
  'agent=makefun-forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done filter',
  'object-format=sha1',
];

const RECEIVE_CAPS =
  'report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=makefun-forge/1.0';

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

function sendGitJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) });
  res.end(payload);
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** Ref lines for a v0 advertisement. First line carries the capabilities. */
function v0RefLines(repo: Repo): Buffer[] {
  const lines: Buffer[] = [];
  const main = repo.refs.get('refs/heads/main');
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
    return lines;
  }
  const headOid = main ?? repo.refs.get(names[0])!;
  lines.push(pktLine(`${headOid} HEAD\0${RECEIVE_CAPS}\n`));
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    lines.push(pktLine(`${oid} ${name}\n`));
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelObject(repo, oid);
      lines.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  return lines;
}

function v2Advertisement(): Buffer[] {
  const out: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH, pktLine('version 2\n')];
  for (const cap of UPLOAD_V2_CAPS) out.push(pktLine(`${cap}\n`));
  out.push(FLUSH);
  return out;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer[] {
  const out: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH, ...v0RefLines(repo)];
  out.push(FLUSH);
  return out;
}

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GitContext,
  owner: string,
  repoName: string,
  service: string,
): void {
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    sendGitJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service === 'git-upload-pack') {
    const proto = (req.headers['git-protocol'] ?? '').trim();
    if (proto === 'version=2') {
      sendGit(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(v2Advertisement()));
    } else {
      sendGit(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(v0Advertisement('git-upload-pack', repo)));
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendGit(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(v0Advertisement('git-receive-pack', repo)));
    return;
  }
  sendGitJson(res, 400, { message: 'unknown service' });
}

// ---------------------------------------------------------------------------------------------
// upload-pack (v2)
// ---------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const lines: Buffer[] = [];
  const main = repo.refs.get('refs/heads/main');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (main) {
    if (matches('HEAD')) {
      let line = `${main} HEAD`;
      if (symrefs) line += ' symref-target:refs/heads/main';
      lines.push(pktLine(`${line}\n`));
    }
  } else if (unborn) {
    let line = 'unborn HEAD';
    if (symrefs) line += ' symref-target:refs/heads/main';
    lines.push(pktLine(`${line}\n`));
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') line += ` peeled:${peelObject(repo, oid)}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

function handleFetch(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const out: Buffer[] = [];
  out.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) out.push(pktLine(`ACK ${ack}\n`));
    out.push(pktLine('ready\n'));
  } else {
    out.push(pktLine('NAK\n'));
  }
  out.push(DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(DELIM);
  }
  if (plan.toSend.size > 0) {
    const pack = packFor(repo, plan.toSend);
    out.push(pktLine('packfile\n'));
    const CHUNK = 65515;
    for (let off = 0; off < pack.length; off += CHUNK) {
      const chunk = pack.subarray(off, Math.min(off + CHUNK, pack.length));
      out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// Packs are content-addressed and immutable, so the pack for a given object
// set never changes. Cache small packs (the clone bench fetches the same
// depth-1 pack 50 times per round); cap the cache to bound memory.
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX_ENTRIES = 256;
const PACK_CACHE_MAX_BYTES = 64 * 1024;

function packFor(repo: Repo, oids: Set<string>): Buffer {
  const sorted = [...oids].sort();
  const key = sorted.join(',');
  const cached = packCache.get(key);
  if (cached) return cached;
  const entries: { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[] = [];
  for (const oid of sorted) {
    const obj = repo.objects.get(oid);
    if (obj) entries.push({ type: obj.type, data: obj.data });
  }
  const pack = writePack(entries);
  if (pack.length <= PACK_CACHE_MAX_BYTES) {
    if (packCache.size >= PACK_CACHE_MAX_ENTRIES) {
      const first = packCache.keys().next().value;
      if (first !== undefined) packCache.delete(first);
    }
    packCache.set(key, pack);
  }
  return pack;
}

export function handleUploadPack(req: IncomingMessage, res: ServerResponse, ctx: GitContext, owner: string, repoName: string, body: Buffer): void {
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    sendGitJson(res, 404, { message: 'Not Found' });
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    sendGitJson(res, 400, { message: 'malformed request' });
    return;
  }
  const args: string[] = [];
  let command: string | null = null;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === null && text.startsWith('command=')) {
      command = text.slice('command='.length);
      continue;
    }
    args.push(text);
  }
  try {
    if (command === 'ls-refs') {
      sendGit(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, args));
    } else if (command === 'fetch') {
      sendGit(res, 200, 'application/x-git-upload-pack-result', handleFetch(repo, args));
    } else {
      sendGitJson(res, 400, { message: 'unknown command' });
    }
  } catch (err) {
    // A malformed v2 request must not take the server down.
    sendGitJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0 push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(req: IncomingMessage, res: ServerResponse, ctx: GitContext, owner: string, repoName: string, body: Buffer): void {
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    sendGitJson(res, 404, { message: 'Not Found' });
    return;
  }
  const report = (unpackOk: boolean, unpackDetail: string, results: { ref: string; ok: boolean; reason: string }[]): void => {
    const stream: Buffer[] = [];
    stream.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`));
    for (const r of results) {
      stream.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
    }
    stream.push(FLUSH);
    const reportStream = Buffer.concat(stream);
    const payload = pktLine(Buffer.concat([Buffer.from([1]), reportStream]));
    sendGit(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([payload, FLUSH]));
  };

  let commands: PushCommand[] = [];
  let packBytes = Buffer.alloc(0);
  try {
    const { payloads, next } = readPktBlock(body, 0);
    packBytes = body.subarray(next);
    for (const payload of payloads) {
      let text = payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const parts = text.split(' ');
      if (parts.length < 3) throw new Error('bad push command');
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  } catch (err) {
    report(false, err instanceof Error ? err.message : 'bad request', []);
    return;
  }
  if (commands.length === 0) {
    report(false, 'no commands', []);
    return;
  }

  // Unpack first: every object in the pack is stored even when a ref is refused.
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const obj of objects) ctx.store.putObject(repo, obj.type, obj.data);
    } catch (err) {
      report(false, err instanceof Error ? err.message : 'pack corrupt', []);
      return;
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (!current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // create
      if (current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // update
    if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
      continue;
    }
    if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  report(true, '', results);
}

// Re-exported helpers the REST layer uses for commits/trees.
export { buildTreeFromMap, closure, flattenTree, isAncestor, makeCommit, parseCommit, parseTag, parseTree, peelObject };
