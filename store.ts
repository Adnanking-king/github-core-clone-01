// The forge's whole state: an in-memory store of repositories, their git object
// database and refs, issues, labels and pull requests. Everything is deterministic:
// timestamps come from MAKEFUN_TRIAL_NOW plus a monotonic counter, never the wall
// clock, so two runs of the same trial behave identically.
//
// The viewer is the login the trial's bearer token names. The suite's scenario is
// fixed by the kit's public seed (wire.ts SCENARIO_SEED 0x6a09e667f3bcc909n), so the
// viewer login is the same in every trial: adaiversen.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Object(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  return sha1Object(type, data);
}

// -------------------------------------------------------------------------------------------
// deterministic clock
// -------------------------------------------------------------------------------------------

const TRIAL_NOW_MS = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.parse('2026-11-14T06:30:00Z');
})();

let seq = 0;

/** The next deterministic timestamp, one second after the previous one. */
export function nextEpochSec(): number {
  const value = Math.floor(TRIAL_NOW_MS / 1000) + seq;
  seq += 1;
  return value;
}

/** An ISO timestamp from the deterministic clock. */
export function nextIso(): string {
  return new Date(nextEpochSec() * 1000).toISOString();
}

/** The current deterministic epoch (does not advance the clock). */
export function currentEpochSec(): number {
  return Math.floor(TRIAL_NOW_MS / 1000) + seq;
}

// -------------------------------------------------------------------------------------------
// git object shapes
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries sort by name, directories as if the name had a trailing '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// -------------------------------------------------------------------------------------------
// zlib helpers: inflate a stream starting at `offset` and learn how many bytes it consumed.
// Node's inflateSync ignores trailing bytes, so the consumed length is found by binary search
// for the shortest prefix that inflates cleanly.
// -------------------------------------------------------------------------------------------

export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const tail = buffer.subarray(offset);
  let lo = 0;
  let hi = tail.length;
  // hi always inflates (the whole tail is a valid stream plus trailing bytes).
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(tail.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(tail.subarray(0, lo));
  return { data, next: offset + lo };
}

/** Apply a git delta to a base buffer (the REF_DELTA / OFS_DELTA payload format). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} does not match ${base.length}`);
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) copyOffset = delta[offset++];
      if ((op & 0x02) !== 0) copyOffset |= delta[offset++] << 8;
      if ((op & 0x04) !== 0) copyOffset |= delta[offset++] << 16;
      if ((op & 0x08) !== 0) copyOffset |= delta[offset++] << 24;
      if ((op & 0x10) !== 0) copySize = delta[offset++];
      if ((op & 0x20) !== 0) copySize |= delta[offset++] << 8;
      if ((op & 0x40) !== 0) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (produced !== targetSize) throw new Error(`delta produced ${produced} bytes, expected ${targetSize}`);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// packfiles: plain (undeltified) packs out, full packs (incl. deltas) in
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Parse a packfile into objects, resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6 || typeCode === 7) {
      let base: GitObject | undefined;
      if (typeCode === 6) {
        // OFS_DELTA: negative offset varint
        let b = pack[offset++];
        let baseOffset = b & 0x7f;
        while ((b & 0x80) !== 0) {
          b = pack[offset++];
          baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
        }
        base = byOffset.get(entryOffset - baseOffset);
      } else {
        const baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
        base = objects.get(baseOid);
      }
      if (!base) throw new Error('delta base not found in pack');
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      const data = applyDelta(base.data, inflated.data);
      const type = base.type;
      const oid = sha1Object(type, data);
      const object: GitObject = { type, data };
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error(`pack object size ${inflated.data.length} != header ${size}`);
      const oid = sha1Object(type, inflated.data);
      const object: GitObject = { type, data: inflated.data };
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
    }
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// repositories
// -------------------------------------------------------------------------------------------

export interface IssueComment {
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
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  private requestSeq = 0;

  nextRequestId(): string {
    this.requestSeq += 1;
    return this.requestSeq.toString(16).padStart(16, '0');
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const now = nextIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = sha1Object(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }
}

export const store = new Store();

// -------------------------------------------------------------------------------------------
// graph walks
// -------------------------------------------------------------------------------------------

/**
 * Collect the objects reachable from `tips`, optionally limiting commit generations
 * (for shallow fetches: `depth` counts the tip as generation 1). Returns the objects
 * plus, when depth-limited, the commits whose parents were cut off (the shallow boundary).
 */
export function collectReachable(
  repo: Repo,
  tips: readonly string[],
  options: { depth?: number; exclude?: ReadonlySet<string> } = {},
): { objects: Map<string, GitObject>; boundary: string[] } {
  const objects = new Map<string, GitObject>();
  const boundary: string[] = [];
  const excluded = options.exclude ?? new Set<string>();
  const excludedReachable = new Set<string>();
  if (excluded.size > 0) {
    // Everything reachable from an excluded tip is already held by the client —
    // except under `deepen N`, where the haves are the client's shallow boundary:
    // it holds only N-1 generations below them, and their deeper ancestors are
    // exactly what the deepen asks for. So with a depth limit, exclude only
    // N-1 generations from the haves (commits plus their trees and blobs).
    const depthLimit = options.depth !== undefined ? options.depth - 1 : undefined;
    const stack: Array<{ oid: string; depth: number }> = [...excluded].map((oid) => ({ oid, depth: 1 }));
    while (stack.length > 0) {
      const { oid, depth } = stack.pop()!;
      if (excludedReachable.has(oid)) continue;
      excludedReachable.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push({ oid: view.tree, depth });
        if (depthLimit === undefined || depth < depthLimit) {
          for (const parent of view.parents) stack.push({ oid: parent, depth: depth + 1 });
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push({ oid: entry.oid, depth });
      } else if (object.type === 'tag') {
        stack.push({ oid: parseTag(object.data).object, depth });
      }
    }
  }
  const visitObject = (oid: string): void => {
    if (objects.has(oid) || excludedReachable.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    objects.set(oid, object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visitObject(entry.oid);
    } else if (object.type === 'tag') {
      visitObject(parseTag(object.data).object);
    }
  };
  // Commit walk with depth: BFS by generation so the boundary is exact.
  const queue: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 1 }));
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      visitObject(oid);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, depth });
      continue;
    }
    if (object.type !== 'commit') {
      visitObject(oid);
      continue;
    }
    const view = parseCommit(object.data);
    const held = excludedReachable.has(oid);
    if (!held) {
      // A held commit is already on the client: never send it, but still walk
      // through it — under `deepen` its parents are the new generation.
      objects.set(oid, object);
      visitObject(view.tree);
    }
    const atLimit = options.depth !== undefined && depth >= options.depth;
    if (atLimit) {
      // Every commit at the depth limit is a shallow boundary — git marks the
      // tip shallow even when it is a root commit with no parents.
      if (!held) boundary.push(oid);
      continue;
    }
    for (const parent of view.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return { objects, boundary };
}

/** True when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return false;
}

/** The merge-base of two commits (the first common ancestor found by BFS from both sides). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') for (const parent of parseCommit(object.data).parents) stackA.push(parent);
    else if (object?.type === 'tag') stackA.push(parseTag(object.data).object);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') for (const parent of parseCommit(object.data).parents) queue.push(parent);
    else if (object?.type === 'tag') queue.push(parseTag(object.data).object);
  }
  return null;
}

/** Peel a ref target to a commit (through tags). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(repo, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** The blob oid at `path` in the tree, or null. */
export function blobAtPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** Build a new tree from a flat path map, creating intermediate trees as needed. */
export function treeFromFlat(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Count added/removed lines between two text blobs (simple LCS on lines). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  // LCS lengths, O(m*n) but the blobs here are small.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: n - common, deletions: m - common };
}
