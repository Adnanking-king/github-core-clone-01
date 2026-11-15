// Entry lifecycle: the harness env owns the trial, this process owns the server.
// Bind an ephemeral port, hand it to the env, then wait until the env reports
// the trial is done and leave with exit 0. The scored work lives in app.ts;
// this file only keeps the process alive and talking to the env, so its
// behaviour must stay exactly as the kit's lifecycle describes:
//
//   1. MAKEFUN_ENV_URL is the env's origin (http://store:8080 inside a trial
//      container). With no URL there is nothing to register with: exit 1.
//   2. Listen on port 0 and let the kernel pick. Never take 8080; the env owns it.
//   3. POST /register {"port": N}. The env dials the address the request came
//      from plus N. The first register wins; a 409 means another entry won and
//      this process simply waits like any other.
//   4. Poll GET /done until {"done": true}. The env answers immediately
//      ({"done": false} while the suite runs), so this is a poll, retried with
//      a short exponential backoff on failure. Never exit before done.
//   5. Close the server and exit 0; the harness stops the env and the scorer
//      reads the export it writes.
//
// Only the local server is imported: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register or done request may take this long before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff starts here and never grows past BACKOFF_CAP_MS. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait after `failures` failed requests: exponential from BACKOFF_FIRST_MS, capped. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

/** POST the bound port until the env accepts it. 200 is normal; 409 means a first
 * register already won, which is not this process's to fix. 400 and 405 are
 * contract errors and end the program; a network error or another status is
 * retried, since the env may still be starting. */
async function register(port: number): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Listen on an ephemeral port and report which one the kernel picked. */
function bindEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  const port = await bindEphemeral(server);
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await register(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
