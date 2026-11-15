// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack and
// v0 receive-pack. No git binary: objects, packs and the protocol are implemented
// here on node:zlib and node:crypto. Packs sent out are plain (undeltified);
// packs received may carry OFS_DELTA / REF_DELTA entries (store.readPack resolves them).

import {
  collectReachable,
  isAncestor,
  peelToCommit,
  readPack,
  sha1Object,
  writePack,
  type GitObject,
  type Repo,
} from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge/1.0';

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode pkt-lines from `buffer`; `consumed` is where the framing stopped (flush or end). */
export function decodePktLines(buffer: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** Split `data` into sideband band-1 pkt-lines (payload <= 65515 bytes each). */
export function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

function pktLinesText(lines: readonly string[]): Buffer {
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

// -------------------------------------------------------------------------------------------
// ref listing
// -------------------------------------------------------------------------------------------

interface RefEntry {
  name: string;
  oid: string;
  peeled?: string;
}

function sortedRefs(repo: Repo): RefEntry[] {
  const entries: RefEntry[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: RefEntry = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled) entry.peeled = peeled;
      }
    }
    entries.push(entry);
  }
  return entries;
}

function defaultBranchTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=forge/1.0';
const RECEIVE_V0_CAPS = 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const tip = defaultBranchTip(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = tip ?? refs[0]!.oid;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function gitInfoRefs(repo: Repo | undefined, service: string, gitProtocol: string | undefined): GitResponse {
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
    }
    return ok('application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
  }
  return notFound();
}

// -------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs and fetch
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  const { packets } = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === '') {
      if (!line.startsWith('command=')) return null;
      command = line.slice('command='.length);
      continue;
    }
    if (!seenDelim) {
      // Capability lines before the delimiter (agent=, object-format=): ignore.
      continue;
    }
    args.push(line);
  }
  return command === '' ? null : { command, args };
}

function lsRefsResponse(repo: Repo, args: readonly string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  const tip = defaultBranchTip(repo);
  if (refs.length === 0) {
    if (wantUnborn) {
      lines.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  } else {
    if (prefixes.length === 0) {
      const headLine = `${tip ?? refs[0]!.oid} HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`;
      lines.push(pktLine(headLine));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (wantPeel && ref.peeled) line += ` peeled:${ref.peeled}`;
      lines.push(pktLine(`${line}\n`));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function fetchResponse(repo: Repo, args: readonly string[]): Buffer {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.depth = Number(arg.slice(7).trim());
    else if (arg === 'done') parsed.done = true;
  }
  const wants = [...new Set(parsed.wants)];
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
  let pack: Buffer | null = null;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (wants.length > 0) {
    const exclude = new Set<string>(parsed.haves);
    const { objects, boundary } = collectReachable(repo, wants, { depth: parsed.depth, exclude });
    if (objects.size > 0) pack = writePack([...objects.values()]);
    shallow = boundary;
    const sent = new Set(objects.keys());
    unshallow = parsed.shallow.filter((oid) => sent.has(oid) && !boundary.includes(oid));
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of shallow) lines.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) lines.push(pktLine(`unshallow ${oid}\n`));
    lines.push(pktDelim());
    parts.push(...lines);
  }
  if (pack !== null) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack, 1));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// upload-pack v0: fetch
// -------------------------------------------------------------------------------------------

function fetchV0Response(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0; // 0 = wants, 1 = haves
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section = 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  const parts: Buffer[] = [pktLine('NAK\n')];
  let pack: Buffer | null = null;
  let boundary: string[] = [];
  let unshallow: string[] = [];
  if (wants.length > 0) {
    const exclude = new Set<string>(haves);
    const result = collectReachable(repo, [...new Set(wants)], { depth, exclude });
    if (result.objects.size > 0) pack = writePack([...result.objects.values()]);
    boundary = result.boundary;
    const sent = new Set(result.objects.keys());
    unshallow = shallow.filter((oid) => sent.has(oid) && !boundary.includes(oid));
  }
  for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (pack !== null) parts.push(...sidebandPackets(pack, 1));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function gitUploadPack(repo: Repo | undefined, body: Buffer, gitProtocol: string | undefined): GitResponse {
  if (repo === undefined) return notFound();
  if (gitProtocol === 'version=2') {
    const parsed = parseV2Command(body);
    if (parsed === null) {
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
    }
    if (parsed.command === 'ls-refs') {
      return ok('application/x-git-upload-pack-result', lsRefsResponse(repo, parsed.args));
    }
    if (parsed.command === 'fetch') {
      return ok('application/x-git-upload-pack-result', fetchResponse(repo, parsed.args));
    }
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  }
  return ok('application/x-git-upload-pack-result', fetchV0Response(repo, body));
}

// -------------------------------------------------------------------------------------------
// receive-pack v0
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function fastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  const oldCommit = peelToCommit(repo, oldOid) ?? oldOid;
  const newCommit = peelToCommit(repo, newOid) ?? newOid;
  return isAncestor(repo, oldCommit, newCommit);
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function gitReceivePack(repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) return notFound();
  const { packets, consumed } = decodePktLines(body);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') capabilities.add(cap.split('=')[0]!);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) {
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (!sawFlush || commands.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  }
  const sideband = capabilities.has('side-band-64k');
  const reportLines: string[] = [];
  const packBytes = body.subarray(consumed);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  if (updatesRef && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, object] of objects) {
        if (sha1Object(object.type, object.data) !== oid) throw new Error('pack object hash mismatch');
        repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  if (!unpackOk) {
    reportLines.push('unpack error\n');
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) reportLines.push(`ng ${command.ref} no such ref\n`);
        else if (current !== command.oldOid) reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} unable to read new object\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) reportLines.push(`ng ${command.ref} already exists\n`);
        else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} no such ref\n`);
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else if (!fastForward(repo, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
  }
  const report = pktLinesText(reportLines);
  const parts: Buffer[] = [];
  if (sideband) parts.push(...sidebandPackets(report, 1));
  else parts.push(report);
  parts.push(pktFlush());
  return ok('application/x-git-receive-pack-result', Buffer.concat(parts));
}
