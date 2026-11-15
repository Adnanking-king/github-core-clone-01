// GitHub REST v3: repositories, branches, commits, contents, issues, comments,
// labels and pull requests. Operates on the same store as git, GraphQL and MCP.

import {
  VIEWER,
  blobAtPath,
  buildCommit,
  flattenTree,
  isAncestor,
  lineDiff,
  mergeBase,
  nextEpochSec,
  nextIso,
  parseCommit,
  parseTree,
  store,
  treeFromFlat,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  /** Absolute URL of the request without the query string (for pagination links). */
  url: string;
}

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const viewerUser = (): Record<string, unknown> => ({
  login: VIEWER.login,
  id: VIEWER.id,
  node_id: 'VXNlcjoxMDAw',
  avatar_url: '',
  type: 'User',
  site_admin: false,
  name: VIEWER.name,
  email: VIEWER.email,
});

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: viewerUser(),
    private: repo.private,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description ?? '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    user: viewerUser(),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headLabel = `${repo.owner}:${pull.head}`;
  const baseLabel = `${repo.owner}:${pull.base}`;
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    user: viewerUser(),
    head: { label: headLabel, ref: pull.head, sha: pull.headSha, user: viewerUser(), repo: repoJson(repo) },
    base: { label: baseLabel, ref: pull.base, sha: pull.baseSha, user: viewerUser(), repo: repoJson(repo) },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** 'MERGEABLE' or 'CONFLICTING' for a pull request (UNKNOWN is never needed here). */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const conflict = mergeConflict(repo, pull);
  return conflict === null ? 'MERGEABLE' : 'CONFLICTING';
}

/**
 * The paths where the head and the base both changed the same file differently
 * since their merge-base, or null when the merge is clean.
 */
export function mergeConflict(repo: Repo, pull: Pull): string[] | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return null;
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return null;
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const fromBase = flattenTree(repo, baseTree);
  const fromHead = flattenTree(repo, headTree);
  const fromBaseTip = flattenTree(repo, baseTipTree);
  const conflicts: string[] = [];
  for (const [path, headEntry] of fromHead) {
    const baseEntry = fromBase.get(path);
    const baseTipEntry = fromBaseTip.get(path);
    const changedOnHead = baseEntry?.oid !== headEntry.oid;
    const changedOnBase = baseEntry?.oid !== baseTipEntry?.oid;
    if (changedOnHead && changedOnBase && baseTipEntry?.oid !== headEntry.oid) conflicts.push(path);
  }
  for (const [path, baseEntry] of fromBase) {
    if (fromHead.has(path)) continue;
    const baseTipEntry = fromBaseTip.get(path);
    const deletedOnHead = true;
    const changedOnBase = baseEntry.oid !== baseTipEntry?.oid;
    if (deletedOnHead && changedOnBase) conflicts.push(path);
  }
  return conflicts.length > 0 ? conflicts : null;
}

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

function notFoundRepo(): RestReply {
  return err(404, 'Not Found');
}

/** The repository for /repos/{owner}/{name} routes, or null when it is not the viewer's. */
function repoOf(segments: string[]): Repo | null {
  const owner = segments[1] ?? '';
  const name = segments[2] ?? '';
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function paginate<T>(items: readonly T[], query: URLSearchParams, url: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const sep = url.includes('?') ? '&' : '?';
  if (page < totalPages) {
    links.push(`<${url}${sep}per_page=${perPage}&page=${page + 1}>; rel="next"`);
    links.push(`<${url}${sep}per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${url}${sep}per_page=${perPage}&page=1>; rel="first"`);
    links.push(`<${url}${sep}per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  }
  if (links.length > 0) headers.link = links.join(', ');
  return { page: [...slice], headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

function refTip(repo: Repo, ref: string): string | null {
  if (ref.startsWith('refs/heads/')) return repo.refs.get(ref) ?? null;
  if (ref.startsWith('refs/tags/')) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const object = repo.objects.get(ref);
  if (object?.type === 'commit') return ref;
  return null;
}

function commitIdentity(): string {
  const epoch = nextEpochSec();
  return `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
}

/** Create a commit on `branch` that sets `path` to `content` (or deletes it). */
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const flat = new Map<string, { oid: string; mode: string }>();
  if (tip) {
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    for (const [key, value] of flattenTree(repo, tree)) flat.set(key, value);
  }
  let blobSha: string | null = null;
  if (content === null) {
    flat.delete(path);
  } else {
    blobSha = store.putObject(repo, 'blob', content);
    flat.set(path, { oid: blobSha, mode: '100644' });
  }
  const treeOid = treeFromFlat(repo, flat);
  const identity = commitIdentity();
  const commit = buildCommit({
    tree: treeOid,
    parents: tip === null ? [] : [tip],
    author: identity,
    committer: identity,
    message,
  });
  const commitSha = store.putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = nextIso();
  return { commitSha, blobSha };
}

function listCommits(repo: Repo, tip: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const view = parseCommit(object.data);
    const authorLine = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
      if (!match) return { name: line, email: '', date: repo.createdAt };
      return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
    };
    out.push({
      sha: oid,
      commit: {
        message: view.message,
        author: authorLine(view.author),
        committer: authorLine(view.committer),
        tree: { sha: view.tree },
      },
      author: viewerUser(),
      committer: viewerUser(),
      parents: view.parents.map((parent) => ({ sha: parent })),
    });
    for (const parent of view.parents) stack.push(parent);
  }
  return out;
}

function createIssue(repo: Repo, input: Record<string, unknown>): RestReply {
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const labelsInput = Array.isArray(input.labels) ? input.labels : [];
  const labelNames: string[] = [];
  for (const entry of labelsInput) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '';
    if (name === '') continue;
    if (!repo.labels.has(name)) return err(422, `Label "${name}" does not exist`);
    labelNames.push(name);
  }
  const now = nextIso();
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssueNumber++,
    title,
    body,
    state: 'open',
    labels: labelNames,
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.push(issue);
  return { status: 201, body: issueJson(repo, issue) };
}

function createPull(repo: Repo, input: Record<string, unknown>): RestReply {
  const stripOwner = (ref: string): string => (ref.includes(':') ? ref.split(':').slice(1).join(':') : ref);
  const head = stripOwner(typeof input.head === 'string' ? input.head : '');
  const base = stripOwner(typeof input.base === 'string' ? input.base : repo.defaultBranch);
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
  const now = nextIso();
  const pull: Pull = {
    id: store.nextPullId++,
    number: repo.nextPullNumber++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head,
    base,
    headSha,
    baseSha,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.push(pull);
  return { status: 201, body: pullJson(repo, pull) };
}

export function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const base = mergeBase(repo, repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha, headTip);
  const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const fromBase = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const fromHead = flattenTree(repo, headTree);
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...fromBase.keys(), ...fromHead.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = fromBase.get(path);
    const newEntry = fromHead.get(path);
    if (oldEntry?.oid === newEntry?.oid) continue;
    const oldText = oldEntry ? repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '' : '';
    const newText = newEntry ? repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '' : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
    out.push({
      sha: newEntry?.oid ?? oldEntry?.oid ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return out;
}

export function mergePull(repo: Repo, pull: Pull): RestReply {
  if (pull.merged) return err(405, 'Pull request already merged');
  const conflict = mergeConflict(repo, pull);
  if (conflict !== null) return err(405, 'Merge conflict');
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
  const headTip = repo.refs.get(`refs/heads/${pull.head}`)!;
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const fromBase = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const fromHead = flattenTree(repo, headTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  for (const [key, value] of flattenTree(repo, baseTipTree)) merged.set(key, value);
  for (const [path, headEntry] of fromHead) {
    if (fromBase.get(path)?.oid !== headEntry.oid) merged.set(path, headEntry);
  }
  for (const [path, baseEntry] of fromBase) {
    if (!fromHead.has(path) && baseEntry.oid !== undefined) merged.delete(path);
  }
  const treeOid = treeFromFlat(repo, merged);
  const identity = commitIdentity();
  const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
  const commit = buildCommit({ tree: treeOid, parents: [baseTip], author: identity, committer: identity, message });
  const mergeSha = store.putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nextIso();
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  pull.updatedAt = nextIso();
  repo.updatedAt = nextIso();
  return { status: 200, body: { sha: mergeSha, merged: true, message: `Pull request #${pull.number} merged` } };
}

// -------------------------------------------------------------------------------------------
// routing
// -------------------------------------------------------------------------------------------

export function handleRest(req: RestRequest): RestReply {
  const { method, segments } = req;
  const seg = (index: number): string => segments[index] ?? '';

  // API root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: {
          current_user_url: '/api/v3/user',
          current_user_authorizations_html_url: '/api/v3/user/authorizations',
          authorizations_url: '/api/v3/authorizations',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return err(404, 'Not Found');
  }
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method === 'GET') {
      return { status: 200, body: { verifiable_password_authentication: true, installed_version: '1.0.0' } };
    }
    return err(404, 'Not Found');
  }
  if (segments.length === 1 && seg(0) === 'user') {
    if (method === 'GET') return { status: 200, body: viewerUser() };
    return err(404, 'Not Found');
  }
  if (segments.length === 2 && seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'GET') {
      const repos = store.listViewerRepos(VIEWER.login);
      const { page, headers } = paginate(repos.map(repoJson), req.query, req.url);
      return { status: 200, body: page, headers };
    }
    if (method === 'POST') {
      const input = bodyRecord(req.body);
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '' || name.includes('/')) return err(422, 'name is required');
      if (store.getRepo(VIEWER.login, name)) return err(422, `Repository "${name}" already exists`);
      const repo = store.createRepo(VIEWER.login, name, input.private === true, typeof input.description === 'string' ? input.description : '');
      return { status: 201, body: repoJson(repo) };
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{name}/...
  if (seg(0) === 'repos' && segments.length >= 3) {
    const repo = repoOf(segments);
    if (repo === null) return notFoundRepo();
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoJson(repo) };
      if (method === 'PATCH') {
        const input = bodyRecord(req.body);
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        repo.updatedAt = nextIso();
        return { status: 200, body: repoJson(repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo.owner, repo.name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name)! }, protected: false }));
      return { status: 200, body: branches };
    }
    if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${decodeURIComponent(rest[1]!)}`);
      if (!sha) return err(404, 'Not Found');
      return { status: 200, body: { name: decodeURIComponent(rest[1]!), commit: { sha }, protected: false } };
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      const tip = refTip(repo, ref);
      if (!tip) return err(404, 'Not Found');
      return { status: 200, body: listCommits(repo, tip) };
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST' && rest.length === 2) {
      const input = bodyRecord(req.body);
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: repo.objects.get(sha)!.type } } };
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).map(decodeURIComponent).join('/');
      const sha = repo.refs.get(ref);
      if (!sha) return err(404, 'Not Found');
      return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'PUT') {
        const input = bodyRecord(req.body);
        const message = typeof input.message === 'string' ? input.message : '';
        const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        if (!repo.refs.has(`refs/heads/${branch}`)) {
          // A contents write creates its branch from the default branch tip.
          const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (baseTip !== undefined) repo.refs.set(`refs/heads/${branch}`, baseTip);
          else if (branch !== repo.defaultBranch) return err(422, 'branch does not exist');
        }
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
        const existing = tip === null ? null : blobAtPath(repo, parseCommit(repo.objects.get(tip)!.data).tree, path);
        const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
        if (existing && givenSha === undefined) return err(422, "sha wasn't supplied");
        if (existing && givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
          return err(409, 'sha does not match the current blob');
        }
        if (!existing && givenSha !== undefined) return err(422, 'sha does not match: the file does not exist');
        const created = existing === null;
        const { commitSha, blobSha } = commitFile(repo, branch, path, content, message);
        return {
          status: created ? 201 : 200,
          body: {
            content: {
              name: path.split('/').pop() ?? path,
              path,
              sha: blobSha,
              size: content.length,
              type: 'file',
              encoding: 'base64',
              content: content.toString('base64'),
            },
            commit: { sha: commitSha, message },
          },
        };
      }
      if (method === 'GET') {
        const ref = req.query.get('ref') ?? repo.defaultBranch;
        const tip = refTip(repo, ref);
        if (!tip) return err(404, 'Not Found');
        const tree = parseCommit(repo.objects.get(tip)!.data).tree;
        if (path === '') {
          const entries = parseTree(repo.objects.get(tree)!.data).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: entry.name,
            sha: entry.oid,
            size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
          }));
          return { status: 200, body: entries };
        }
        const found = blobAtPath(repo, tree, path);
        if (found && found.mode !== '40000') {
          const blob = repo.objects.get(found.oid)!;
          return {
            status: 200,
            body: {
              type: 'file',
              encoding: 'base64',
              size: blob.data.length,
              name: path.split('/').pop() ?? path,
              path,
              content: blob.data.toString('base64'),
              sha: found.oid,
            },
          };
        }
        // Directory?
        const flat = flattenTree(repo, tree);
        const prefix = `${path}/`;
        const children = new Map<string, { mode: string; oid: string }>();
        for (const [key, value] of flat) {
          if (!key.startsWith(prefix)) continue;
          const restPath = key.slice(prefix.length);
          const first = restPath.split('/')[0]!;
          if (!children.has(first)) {
            if (restPath.includes('/')) {
              // a directory: find its tree oid by walking
              const dirEntry = blobAtPath(repo, tree, `${path}/${first}`);
              children.set(first, { mode: '40000', oid: dirEntry?.oid ?? '' });
            } else {
              children.set(first, { mode: value.mode, oid: value.oid });
            }
          }
        }
        if (children.size > 0) {
          const entries = [...children.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([name, value]) => ({
              type: value.mode === '40000' ? 'dir' : 'file',
              name,
              path: `${path}/${name}`,
              sha: value.oid,
              size: value.mode === '40000' ? 0 : repo.objects.get(value.oid)?.data.length ?? 0,
            }));
          return { status: 200, body: entries };
        }
        return err(404, 'Not Found');
      }
      if (method === 'DELETE') {
        const input = bodyRecord(req.body);
        const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
        if (!tip) return err(404, 'Not Found');
        const existing = blobAtPath(repo, parseCommit(repo.objects.get(tip)!.data).tree, path);
        if (!existing) return err(404, 'Not Found');
        const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
        if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
          return err(409, 'sha does not match the current blob');
        }
        const message = typeof input.message === 'string' ? input.message : '';
        const { commitSha } = commitFile(repo, branch, path, null, message);
        return { status: 200, body: { commit: { sha: commitSha } } };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'labels' && method === 'POST' && rest.length === 1) {
      const input = bodyRecord(req.body);
      const name = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      if (name === '') return err(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing) return { status: 200, body: labelJson(existing) };
      const label = { name, color, description: typeof input.description === 'string' ? input.description : '' };
      repo.labels.set(name, label);
      return { status: 201, body: labelJson(label) };
    }
    if (rest[0] === 'labels' && method === 'GET' && rest.length === 1) {
      return { status: 200, body: [...repo.labels.values()].map(labelJson) };
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') return createIssue(repo, bodyRecord(req.body));
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const { page, headers } = paginate(issues.map((issue) => issueJson(repo, issue)), req.query, req.url);
          return { status: 200, body: page, headers };
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (!issue) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
        if (method === 'PATCH') {
          const input = bodyRecord(req.body);
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          if (Array.isArray(input.labels)) {
            const names: string[] = [];
            for (const entry of input.labels) {
              const name = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '';
              if (name !== '' && !repo.labels.has(name)) return err(422, `Label "${name}" does not exist`);
              if (name !== '') names.push(name);
            }
            issue.labels = names;
          }
          issue.updatedAt = nextIso();
          return { status: 200, body: issueJson(repo, issue) };
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return {
            status: 200,
            body: issue.comments.map((comment) => ({
              id: comment.id,
              body: comment.body,
              user: viewerUser(),
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
              html_url: '',
              url: '',
            })),
          };
        }
        if (method === 'POST') {
          const input = bodyRecord(req.body);
          const now = nextIso();
          const comment = { id: store.nextCommentId++, body: typeof input.body === 'string' ? input.body : '', createdAt: now, updatedAt: now };
          issue.comments.push(comment);
          issue.updatedAt = now;
          return {
            status: 201,
            body: { id: comment.id, body: comment.body, user: viewerUser(), created_at: comment.createdAt, updated_at: comment.updatedAt, html_url: '', url: '' },
          };
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') return createPull(repo, bodyRecord(req.body));
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const { page, headers } = paginate(pulls.map((pull) => pullJson(repo, pull)), req.query, req.url);
          return { status: 200, body: page, headers };
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        return { status: 200, body: pullFiles(repo, pull) };
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        return mergePull(repo, pull);
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
