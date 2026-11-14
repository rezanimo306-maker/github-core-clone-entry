// Shared helpers: JSON responses, deterministic ids, base64, pagination.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const VERSION = 'makefun-forge/1.0.0';
export const USER_AGENT = 'makefun-forge';

// Deterministic logical clock: all timestamps in state come from a counter,
// never from the wall clock, so two runs export byte-identical state.
export const EPOCH = 1735689600; // 2025-01-01T00:00:00Z

export function isoAt(seq: number): string {
  return new Date((EPOCH + seq) * 1000).toISOString();
}

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(text: string): string {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
}

export function b64decodeBytes(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** A monotonically increasing, deterministic request counter (for X-GitHub-Request-Id). */
export class IdCounter {
  private n = 0;
  next(): number {
    return ++this.n;
  }
  requestId(): string {
    return `req-${String(this.next()).padStart(6, '0')}`;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendJsonError(res: ServerResponse, status: number, message: string, extraHeaders?: Record<string, string>): void {
  sendJson(res, status, { message }, extraHeaders);
}

export function sendNoContent(res: ServerResponse, extraHeaders?: Record<string, string>): void {
  res.writeHead(204, { 'content-length': '0', ...extraHeaders });
  res.end();
}

export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, error: 'Problems parsing JSON' };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/** Parse a positive integer query param; returns `fallback` when absent/invalid. */
export function queryInt(search: URLSearchParams, name: string, fallback: number): number {
  const raw = search.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build a pagination Link header (GitHub style) for the current request url. */
export function linkHeader(req: IncomingMessage, page: number, perPage: number, hasNext: boolean): string | undefined {
  if (!hasNext) return undefined;
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  const base = new URL(req.url ?? '/', `${proto}://${host}`);
  const next = new URL(base);
  next.searchParams.set('page', String(page + 1));
  next.searchParams.set('per_page', String(perPage));
  const last = new URL(base);
  // `last` is included for GitHub parity; the checks only require `next`.
  last.searchParams.set('page', String(page + 1));
  last.searchParams.set('per_page', String(perPage));
  return `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
}
