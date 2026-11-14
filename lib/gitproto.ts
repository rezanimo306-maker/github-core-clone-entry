// Git wire protocol primitives: pkt-lines, packfiles, git objects,
// reachability and shallow-clone computation. Pure functions over a store.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { objectId, type GitObject, type ObjectType, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const out = Buffer.alloc(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(out, 4);
  return out;
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a pkt-line stream. Throws on malformed input. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = Number.parseInt(buf.toString('ascii', pos, pos + 4), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (len === 2) {
      out.push({ kind: 'data', payload: Buffer.alloc(0) });
      pos += 4;
    } else {
      if (pos + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return out;
}

/** Read pkt-lines until the first flush (inclusive). Returns the data payloads. */
export function readPktBlock(buf: Buffer, start = 0): { payloads: Buffer[]; next: number } {
  const payloads: Buffer[] = [];
  let pos = start;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line');
    const len = Number.parseInt(buf.toString('ascii', pos, pos + 4), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) return { payloads, next: pos + 4 };
    if (len === 1 || len === 2) {
      pos += 4;
      continue;
    }
    if (pos + len > buf.length) throw new Error('truncated pkt-line payload');
    payloads.push(buf.subarray(pos + 4, pos + len));
    pos += len;
  }
  return { payloads, next: pos };
}

// ---------------------------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function makeCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('ascii', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    pos = nul + 21;
  }
  return out;
}

/** Git tree-entry sort: compare name bytes, treating directories as name + '/'. */
export function treeSortKey(entry: TreeEntry): Buffer {
  const name = Buffer.from(entry.name, 'utf8');
  if (entry.mode === '40000') return Buffer.concat([name, Buffer.from('/')]);
  return name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = buf[pos] & 0x7f;
  let shift = 7;
  pos += 1;
  while (buf[pos - 1] & 0x80) {
    value |= (buf[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readVarint(delta, pos);
  pos = src.next;
  const tgt = readVarint(delta, pos);
  pos = tgt.next;
  if (src.value !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      written += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgt.value) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

export interface PackObject {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

/** Read a packfile. Supports plain objects and OFS/REF deltas. */
export function readPack(buf: Buffer): PackObject[] {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects: PackObject[] = [];
  const byOffset = new Map<number, PackObject>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    let byte = buf[pos++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: PackObject | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint
      byte = buf[pos++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      base = byOffset.get(start - offset);
      if (!base) throw new Error('ofs-delta base not found');
    } else if (typeCode === 7) {
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      base = objects.find((o) => o.oid === baseOid);
      if (!base) throw new Error('ref-delta base not found');
    }
    const inflated = inflateSync(buf.subarray(pos), { info: true }) as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = inflated.buffer;
    const consumed = inflated.engine.bytesWritten;
    pos += consumed;
    let type: ObjectType;
    let raw: Buffer;
    if (typeCode === 6 || typeCode === 7) {
      if (!base) throw new Error('delta without base');
      raw = applyDelta(base.data, data);
      type = base.type;
    } else {
      type = PACK_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      raw = data;
    }
    if (raw.length !== size) throw new Error('pack object size mismatch');
    const obj: PackObject = { type, data: raw, oid: objectId(type, raw) };
    objects.push(obj);
    byOffset.set(start, obj);
  }
  return objects;
}

export function writePack(entries: { type: ObjectType; data: Buffer }[]): Buffer {
  // Precompute each object's id once; the sort must not re-hash per comparison.
  const withOid = entries.map((entry) => ({ ...entry, oid: objectId(entry.type, entry.data) }));
  withOid.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(withOid.length, 8);
  const parts: Buffer[] = [header];
  for (const entry of withOid) {
    const size = entry.data.length;
    const typeCode = PACK_TYPE_CODES[entry.type];
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    headerBytes.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export interface ObjectSource {
  getObject(oid: string): GitObject | undefined;
}

/** Peel a tag object to its ultimate non-tag target (or the oid itself). */
export function peelObject(src: ObjectSource, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 32; i++) {
    const obj = src.getObject(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

/** All object oids reachable from the given tips (commits, trees, blobs, tags). */
export function closure(src: ObjectSource, tips: string[]): Set<string> {
  return closureCut(src, tips, new Set());
}

/**
 * Like closure(), but the traversal stops at commits in `cut`: the cut commit
 * itself and its tree/blobs are included, but its parents are not. This is how
 * a server reasons about a shallow client's haves — the client holds a shallow
 * boundary commit but not the history behind it.
 */
export function closureCut(src: ObjectSource, tips: string[], cut: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = src.getObject(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!cut.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Commit oids reachable from the given tips (tags peeled). */
export function commitClosure(src: ObjectSource, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = tips.map((t) => peelObject(src, t));
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = src.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return seen;
}

export function isAncestor(src: ObjectSource, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [peelObject(src, descendant)];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = src.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** First common ancestor of a and b (BFS from b over a's ancestor set). */
export function mergeBase(src: ObjectSource, a: string, b: string): string | null {
  const ancestorsA = commitClosure(src, [a]);
  const seen = new Set<string>();
  const queue = [peelObject(src, b)];
  while (queue.length) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = src.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/** Flatten a commit's tree to path -> {oid, mode} (files only). */
export function flattenTree(src: ObjectSource, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = src.getObject(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) a tree from a flat path map; returns the root tree oid. */
export function buildTreeFromMap(store: Store, repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: file.mode, name: rest, oid: file.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir)!.set(path, file);
      }
    }
    for (const [dir, sub] of dirs) {
      const subPrefix = prefix ? `${prefix}/${dir}` : dir;
      const oid = build(subPrefix);
      entries.push({ mode: '40000', name: dir, oid });
    }
    const data = buildTree(entries);
    return store.putObject(repo, 'tree', data);
  };
  return build('');
}

/** List commit oids reachable from a tip, tip-first (DFS, parents in order). */
export function listCommits(src: ObjectSource, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [peelObject(src, tip)];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = src.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i]);
  }
  return out;
}

export interface ThreeWayResult {
  conflict: boolean;
  merged: Map<string, { oid: string; mode: string }>;
}

/**
 * Three-way merge of headTip onto baseTip using their merge-base.
 * Returns the merged flat file map and whether the merge conflicts
 * (a path changed on both sides to different content).
 */
export function threeWay(src: ObjectSource, headTip: string, baseTip: string): ThreeWayResult {
  const base = mergeBase(src, headTip, baseTip);
  const headTree = flattenTree(src, parseCommit(src.getObject(peelObject(src, headTip))!.data).tree);
  const baseTree = flattenTree(src, parseCommit(src.getObject(peelObject(src, baseTip))!.data).tree);
  const baseTreeAtMerge = base
    ? flattenTree(src, parseCommit(src.getObject(peelObject(src, base))!.data).tree)
    : new Map<string, { oid: string; mode: string }>();
  const merged = new Map<string, { oid: string; mode: string }>();
  let conflict = false;
  const paths = new Set([...headTree.keys(), ...baseTree.keys(), ...baseTreeAtMerge.keys()]);
  for (const path of paths) {
    const h = headTree.get(path);
    const b = baseTree.get(path);
    const m = baseTreeAtMerge.get(path);
    const headChanged = (h?.oid ?? null) !== (m?.oid ?? null);
    const baseChanged = (b?.oid ?? null) !== (m?.oid ?? null);
    if (headChanged && baseChanged && (h?.oid ?? null) !== (b?.oid ?? null)) {
      conflict = true;
      continue;
    }
    const winner = headChanged ? h : b;
    if (winner) merged.set(path, winner);
  }
  return { conflict, merged };
}

// ---------------------------------------------------------------------------------------------
// shallow fetch computation
// ---------------------------------------------------------------------------------------------

export interface ShallowPlan {
  toSend: Set<string>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Compute what a v2 fetch must send. `wants` are tip oids, `haves` are oids the
 * client already has, `depth` is null for a full fetch. `prevShallow` are the
 * client's current shallow boundaries.
 */
export function planFetch(
  src: ObjectSource,
  wants: string[],
  haves: string[],
  depth: number | null,
  prevShallow: string[],
): ShallowPlan {
  const haveSet = new Set(haves);
  const acks = haves.filter((h) => src.getObject(h) !== undefined);
  // For a shallow fetch the client's haves stop at its shallow boundaries:
  // it holds those commits but not the history behind them, so the have
  // closure must not traverse past them.
  const haveClosure = depth === null ? closure(src, haves) : closureCut(src, haves, new Set(prevShallow));

  if (depth === null) {
    const wantClosure = closure(src, wants);
    const toSend = new Set<string>();
    for (const oid of wantClosure) if (!haveClosure.has(oid)) toSend.add(oid);
    return { toSend, shallow: [], unshallow: [], acks };
  }

  // Generation depth from the wants (tags peeled to commits). Only generations
  // up to depth-1 matter: a commit at generation depth-1 is a boundary and its
  // parents are neither included nor boundary, so the walk stops there.
  const gen = new Map<string, number>();
  const queue: { oid: string; g: number }[] = wants.map((w) => ({ oid: peelObject(src, w), g: 0 }));
  let head = 0;
  while (head < queue.length) {
    const { oid, g } = queue[head++];
    if (gen.has(oid) && gen.get(oid)! <= g) continue;
    gen.set(oid, g);
    if (g >= depth - 1) continue;
    const obj = src.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, g: g + 1 });
  }
  const included = new Set<string>();
  for (const [oid, g] of gen) if (g < depth) included.add(oid);
  const boundary = new Set<string>();
  for (const [oid, g] of gen) {
    if (g !== depth - 1) continue;
    const obj = src.getObject(oid);
    if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) boundary.add(oid);
  }
  const unshallow = prevShallow.filter((s) => included.has(s) && !boundary.has(s));
  // Objects of the included commits only (their trees/blobs), NOT ancestors
  // beyond the depth boundary. closure() would follow parents, so build it
  // manually from the included set.
  const wantClosure = new Set<string>();
  for (const oid of included) {
    wantClosure.add(oid);
    const obj = src.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const treeOid = parseCommit(obj.data).tree;
    const treeStack = [treeOid];
    while (treeStack.length) {
      const t = treeStack.pop()!;
      if (wantClosure.has(t)) continue;
      const tobj = src.getObject(t);
      if (!tobj) continue;
      wantClosure.add(t);
      if (tobj.type === 'tree') {
        for (const e of parseTree(tobj.data)) treeStack.push(e.oid);
      }
    }
  }
  // Tag objects named in `wants` must be sent even when their commit is shallow.
  for (const w of wants) {
    const obj = src.getObject(w);
    if (obj && obj.type === 'tag') wantClosure.add(w);
  }
  const toSend = new Set<string>();
  for (const oid of wantClosure) if (!haveClosure.has(oid)) toSend.add(oid);
  return { toSend, shallow: [...boundary], unshallow, acks };
}
