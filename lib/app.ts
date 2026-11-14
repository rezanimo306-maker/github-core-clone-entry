// HTTP server + routing for the forge. Four surfaces, one process, one store:
//   GET  /healthz                       (no auth)
//   POST /mcp                          (MCP, Streamable HTTP)
//   POST /api/graphql                  (GraphQL v4)
//   *    /api/v3/*                     (REST v3)
//   GET  /{owner}/{repo}.git/info/refs (git smart HTTP advertisement)
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { readBody, sendJson } from './util.ts';
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, requestIdHeader } from './rest.ts';

export interface AppOptions {
  shopToken: string;
}

const GIT_SERVICE_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(options: AppOptions): Server {
  const store = new Store();
  const shopToken = options.shopToken;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (path === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true }, requestIdHeader());
          return;
        }

        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestIdHeader());
            return;
          }
          const body = await readBody(req);
          handleMcp(req, res, { store, shopToken }, body);
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestIdHeader());
            return;
          }
          const body = await readBody(req);
          handleGraphql(req, res, { store }, shopToken, body);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path.split('/').filter((s) => s.length > 0).slice(2);
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const handled = handleRest(req, res, { store, shopToken }, segments, url.searchParams, body);
          if (!handled) sendJson(res, 404, { message: 'Not Found' }, requestIdHeader());
          return;
        }

        const gitMatch = GIT_SERVICE_RE.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const service = gitMatch[3];
          if (service === 'info/refs' && method === 'GET') {
            handleInfoRefs(req, res, { store }, owner, repoName, url.searchParams.get('service') ?? '');
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            handleUploadPack(req, res, { store }, owner, repoName, body);
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            handleReceivePack(req, res, { store }, owner, repoName, body);
            return;
          }
          sendJson(res, 405, { message: 'Method Not Allowed' }, requestIdHeader());
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, requestIdHeader());
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, requestIdHeader());
        } else {
          res.destroy();
        }
      }
    })();
  });

  return server;
}
