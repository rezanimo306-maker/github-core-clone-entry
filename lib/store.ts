// In-memory store: one process, one store shared by git / REST / GraphQL / MCP.
// All state is deterministic: timestamps come from a logical counter, ids from
// counters, never from the wall clock or Math.random.
import { createHash } from 'node:crypto';
import { EPOCH, isoAt } from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer; // raw object content (without the "<type> <size>\0" header)
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string; // branch name
  base: string; // branch name
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // refname -> oid
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextNumber: number; // shared issue/PR number sequence (GitHub behaviour)
  /** Object lookup (satisfies gitproto's ObjectSource). */
  getObject(oid: string): GitObject | undefined;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export class Store {
  readonly repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  private nextRepoId = 5000;
  private nextNodeId = 10000; // issue + PR ids
  private nextCommentId = 20000;
  private clock = 0; // logical clock; timestamps are EPOCH + clock seconds

  /** Next deterministic timestamp (ISO string). */
  tick(): string {
    this.clock += 1;
    return isoAt(this.clock);
  }

  /** Next deterministic timestamp as Unix seconds. */
  tickSeconds(): number {
    this.clock += 1;
    return EPOCH + this.clock;
  }

  now(): string {
    return isoAt(this.clock);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = this.tick();
    const objects = new Map<string, GitObject>();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects,
      getObject: (oid: string) => objects.get(oid),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  nextIssueId(): number {
    return this.nextNodeId++;
  }

  nextCommentIdValue(): number {
    return this.nextCommentId++;
  }

  // ---- git objects ---------------------------------------------------------

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }
}
