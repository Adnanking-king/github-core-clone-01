// Model Context Protocol over streamable HTTP (JSON only, no SSE): the 2026-07-28
// revision via server/discover, with the legacy initialize handshake answered too.
// Tools act on the same store as REST, so a repository or issue created over MCP
// reads back over /api/v3 as the same object.

import { VIEWER, nextIso, store, type Repo } from './store.ts';
import { mergePull } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

export interface McpReply {
  status: number;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One fixed tool list: two tools/list calls answer the same array, byte for byte. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        owner: Object.freeze({ type: 'string', description: 'The owner login (defaults to the viewer).' }),
      }),
      required: Object.freeze(['name']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
      additionalProperties: false,
    }),
  }),
]);

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues`,
  };
}

function issueJson(repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function toolOk(result: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Split owner/repo out of the arguments, honouring a full_name property too. */
function repoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  const fullName = typeof args.full_name === 'string' ? args.full_name : '';
  if ((owner === '' || repo === '') && fullName.includes('/')) {
    const [fullOwner, fullRepo] = fullName.split('/', 2);
    if (owner === '') owner = fullOwner ?? '';
    if (repo === '') repo = fullRepo ?? '';
  }
  return { owner, repo };
}

function missing(args: Record<string, unknown>, required: readonly string[]): string | null {
  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const absent = missing(args, ['name']);
      if (absent) return toolError(`Missing required argument: ${absent}`);
      const repoName = String(args.name);
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
      if (owner !== VIEWER.login) return toolError(`Cannot create a repository for ${owner}`);
      if (store.getRepo(owner, repoName)) return toolError(`Repository "${repoName}" already exists`);
      const repo = store.createRepo(
        owner,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const absent = missing(args, ['owner', 'repo']);
      if (absent) return toolError(`Missing required argument: ${absent}`);
      const { owner, repo: repoName } = repoArgs(args);
      const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const absent = missing(args, ['owner', 'repo', 'title']);
      if (absent) return toolError(`Missing required argument: ${absent}`);
      const { owner, repo: repoName } = repoArgs(args);
      const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const now = nextIso();
      const issue = {
        id: store.nextIssueId++,
        number: repo.nextIssueNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as never[],
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.push(issue);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const absent = missing(args, ['owner', 'repo']);
      if (absent) return toolError(`Missing required argument: ${absent}`);
      const { owner, repo: repoName } = repoArgs(args);
      const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return toolOk(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const absent = missing(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (absent) return toolError(`Missing required argument: ${absent}`);
      const { owner, repo: repoName } = repoArgs(args);
      const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('head or base branch does not exist');
      const now = nextIso();
      const pull = {
        id: store.nextPullId++,
        number: repo.nextPullNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
        head,
        base,
        headSha,
        baseSha,
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.push(pull);
      return toolOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const absent = missing(args, ['owner', 'repo', 'pull_number']);
      if (absent) return toolError(`Missing required argument: ${absent}`);
      const { owner, repo: repoName } = repoArgs(args);
      const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return toolError(`Pull request #${number} not found`);
      const result = mergePull(repo, pull);
      if (result.status !== 200) {
        const message = typeof (result.body as Record<string, unknown>).message === 'string' ? String((result.body as Record<string, unknown>).message) : 'merge failed';
        return toolError(message);
      }
      return toolOk(pullJson(repo, pull));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Handle one POST /mcp body (already read as text). Auth is checked by the caller.
 * Notifications (no id) answer 202 with no body.
 */
export function handleMcp(rawBody: string): McpReply {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const entry of body) {
      const reply = handleOne(entry);
      if (reply !== null) results.push(reply.body);
    }
    return { status: 200, body: results };
  }
  const reply = handleOne(body);
  if (reply === null) return { status: 202, body: null };
  return reply;
}

function handleOne(body: unknown): McpReply | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = body as Record<string, unknown>;
  const id = request.id as string | number | undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (isNotification) return null;
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === name);
    if (!known) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    return { status: 200, body: rpcResult(id, callTool(name, args)) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
