// makefun-forge — a GitHub-compatible git forge in one Node 22 program.
// Lifecycle: bind an ephemeral port, register it with the harness environment,
// poll the environment's /done endpoint, exit 0 when done.
//
// The forge itself lives in lib/*.ts and is wired up by createApp() below.
// Run with: node main.ts   (Node 22 type stripping; stdlib only, no deps)
import { createApp } from './lib/app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  process.stderr.write('MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}
const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
if (!shopToken) {
  process.stderr.write('MAKEFUN_SHOP_TOKEN is not set\n');
  process.exit(1);
}

const app = createApp({ shopToken });

// The harness stops the entry when the trial ends; close the server and exit
// cleanly instead of being killed mid-request.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // If the server does not drain quickly, exit anyway.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

const server = app.listen(0, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.stderr.write(`makefun-forge listening on port ${port}\n`);
  const base = envUrl.replace(/\/$/, '');
  const registerUrl = `${base}/register`;
  const doneUrl = `${base}/done`;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const pollDone = async (): Promise<void> => {
    let delay = 250;
    while (true) {
      try {
        const res = await fetch(doneUrl, { signal: AbortSignal.timeout(30000) });
        if (res.ok) {
          const body = (await res.json()) as { done?: boolean };
          if (body.done) break;
        }
      } catch {
        // The environment may not be up yet or a poll may time out; keep polling.
      }
      await sleep(delay);
      if (delay < 2000) delay *= 2;
    }
    server.close();
    process.exit(0);
  };

  fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  })
    .then((res) => {
      if (!res.ok) {
        process.stderr.write(`registration failed: HTTP ${res.status}\n`);
        process.exit(1);
      }
      return pollDone();
    })
    .catch((err) => {
      process.stderr.write(`registration error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
});
