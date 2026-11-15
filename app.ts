// The forge's HTTP server: /healthz, git smart HTTP, REST v3, GraphQL v4 and MCP.
// Every reply is JSON (never HTML) and carries X-GitHub-Request-Id. Every API call
// except /healthz requires Authorization: Bearer $MAKEFUN_SHOP_TOKEN; a missing or
// wrong token is 401. A malformed JSON body is 400. Unknown routes are JSON 404s.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gitInfoRefs, gitReceivePack, gitUploadPack } from './git.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function requestId(): string {
  return store.nextRequestId();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The token presented, or null. A wrong token is refused exactly like a missing one. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns { ok: false } on malformed JSON (empty body is ok). */
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. It takes no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/info/refs, /git-upload-pack, /git-receive-pack.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    const owner = gitMatch[1]!;
    const repoName = gitMatch[2]!;
    const suffix = gitMatch[3] ?? '';
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const repo = owner === 'adaiversen' ? store.getRepo(owner, repoName) : undefined;
    if (suffix.startsWith('/info/refs')) {
      const service = queryOf(req).get('service') ?? '';
      const gitProtocol = req.headers['git-protocol'];
      const reply = gitInfoRefs(repo, service, typeof gitProtocol === 'string' ? gitProtocol : undefined);
      if (reply.status === 404) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendBytes(res, reply.status, reply.contentType, reply.body);
      return;
    }
    if (suffix === '/git-upload-pack' && method === 'POST') {
      const raw = await readBody(req);
      const gitProtocol = req.headers['git-protocol'];
      const reply = gitUploadPack(repo, raw, typeof gitProtocol === 'string' ? gitProtocol : undefined);
      if (reply.status === 404) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (reply.status !== 200) {
        sendJson(res, reply.status, { message: 'Bad Request' });
        return;
      }
      sendBytes(res, reply.status, reply.contentType, reply.body);
      return;
    }
    if (suffix === '/git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      const reply = gitReceivePack(repo, raw);
      if (reply.status === 404) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (reply.status !== 200) {
        sendJson(res, reply.status, { message: 'Bad Request' });
        return;
      }
      sendBytes(res, reply.status, reply.contentType, reply.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const reply = handleGraphQL(parsed.value);
    sendJson(res, reply.status, reply.body);
    return;
  }

  // MCP over streamable HTTP.
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const reply = handleMcp(raw.toString('utf8'));
    if (reply.body === null) {
      res.writeHead(reply.status, { 'x-github-request-id': requestId(), 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const segments = path === '/api/v3' || path === '/api/v3/' ? [] : path.slice('/api/v3/'.length).split('/');
    const host = req.headers.host ?? '127.0.0.1';
    const request: RestRequest = {
      method,
      segments,
      query: queryOf(req),
      body: parsed.value,
      url: `http://${host}${path}`,
    };
    const reply = handleRest(request);
    sendJson(res, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  // Anything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
