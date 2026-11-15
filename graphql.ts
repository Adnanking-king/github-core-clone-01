// GitHub GraphQL v4: a small parser and executor for the documents gh and
// github-mcp-server actually send. No schema library: the schema is a table of
// field names per type (used both for execution and for __type introspection),
// and unknown fields answer HTTP 200 with an errors array naming the field.

import {
  VIEWER,
  flattenTree,
  mergeBase,
  nextIso,
  parseCommit,
  store,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { mergePull, pullFiles } from './rest.ts';

// -------------------------------------------------------------------------------------------
// lexer / parser for the GraphQL subset the suite sends
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '{') {
        this.pos -= 1;
        operations.push({ operation: 'query', variables: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${token.value}`);
      if (token.value === 'fragment') {
        const name = (this.next() as { value: string }).value;
        const on = (this.next() as { value: string }).value;
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = (this.next() as { value: string }).value;
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'query' || token.value === 'mutation') {
        const operation = token.value as 'query' | 'mutation';
        let name: string | undefined;
        const next = this.peek();
        if (next?.kind === 'name') name = (this.next() as { value: string }).value;
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation, name, variables, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected keyword ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const variables: Array<{ name: string; defaultValue?: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const name = (this.next() as { value: string }).value;
        // Skip the type (names, [], !).
        for (;;) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '=') {
            variables.push({ name, defaultValue: this.parseValue() });
            break;
          }
          if (token.kind === 'punct' && (token.value === ',' || token.value === ')')) {
            this.pos -= 1;
            variables.push({ name });
            break;
          }
        }
        if (this.peek()?.kind === 'punct' && this.peek()?.value === ')') break;
      }
      this.expectPunct(')');
    }
    return variables;
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = (this.next() as { value: string }).value;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: (this.next() as { value: string }).value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = (this.next() as { value: string }).value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.next();
      if (token.kind === 'spread') {
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = (this.next() as { value: string }).value;
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (next?.kind === 'name') {
          selections.push({ kind: 'fragmentSpread', name: (this.next() as { value: string }).value });
          this.skipDirectives();
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected selection token ${token.value}`);
      let alias: string | undefined;
      let name = token.value;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
        this.next();
        alias = name;
        name = (this.next() as { value: string }).value;
      }
      let args: Array<{ name: string; value: ValueNode }> = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') args = this.parseArguments();
      this.skipDirectives();
      let selectionSet: SelectionNode[] | undefined;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', field: { alias, name, args, selectionSet } });
    }
    this.expectPunct('}');
    return selections;
  }
}

// -------------------------------------------------------------------------------------------
// schema: field names per type (execution + __type introspection)
// -------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'url', 'createdAt', 'updatedAt', 'isPrivate',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'labels', 'comments', 'author', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'createdAt', 'updatedAt', 'mergeCommit', 'author', 'url', 'headRef', 'baseRef',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description', 'ofType', 'interfaces'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function typeKind(name: string): 'OBJECT' | 'ENUM' | null {
  if (name in SCHEMA_FIELDS) return 'OBJECT';
  if (name in SCHEMA_ENUMS) return 'ENUM';
  return null;
}

// -------------------------------------------------------------------------------------------
// global ids: opaque base64, stable across reads
// -------------------------------------------------------------------------------------------

function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function findRepoByDbId(dbid: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === dbid) return repo;
  return undefined;
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.id, pull.number);
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

type RuntimeValue =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string; id: number; name: string; email: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[] }
  | { __typename: 'IssueEdge'; repo: Repo; issue: Issue; cursor: string }
  | { __typename: 'Label'; name: string; color: string; description: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestChangedFileConnection'; files: Array<Record<string, unknown>> }
  | { __typename: 'PullRequestChangedFile'; file: Record<string, unknown> }
  | { __typename: 'IssueComment'; id: string; body: string }
  | { __typename: 'IssueCommentEdge'; comment: { id: string; body: string } }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; comment: { id: string; body: string } }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | null;

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function executeSelection(
  selections: SelectionNode[],
  parentType: string,
  parent: RuntimeValue,
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) {
        Object.assign(out, executeSelection(fragment.selectionSet, fragment.typeCondition, parent, ctx));
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition;
      if (condition === undefined || (parent !== null && parent.__typename === condition)) {
        Object.assign(out, executeSelection(selection.selectionSet, condition ?? parentType, parent, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    out[key] = executeField(field, parentType, parent, ctx);
  }
  return out;
}

function executeField(field: FieldNode, parentType: string, parent: RuntimeValue, ctx: ExecContext): unknown {
  if (field.name === '__typename') return parent === null ? null : parent.__typename;
  if (parent === null) return null;
  const args = argsOf(field, ctx);
  const sub = field.selectionSet ?? [];

  switch (parent.__typename) {
    case 'Query': {
      if (field.name === 'viewer') {
        return executeSelection(sub, 'User', { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, ctx);
      }
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER.login) return null;
        const repo = store.getRepo(owner, name);
        if (!repo) return null;
        return executeSelection(sub, 'Repository', { __typename: 'Repository', repo }, ctx);
      }
      if (field.name === 'node') {
        const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = findRepoByDbId(Number(parsed.parts[0]));
          if (!repo) return null;
          return executeSelection(sub, 'Repository', { __typename: 'Repository', repo }, ctx);
        }
        if (parsed.kind === 'Issue') {
          const repo = findRepoByDbId(Number(parsed.parts[0]));
          const issue = repo?.issues.find((entry) => entry.number === Number(parsed.parts[1]));
          if (!repo || !issue) return null;
          return executeSelection(sub, 'Issue', { __typename: 'Issue', repo, issue }, ctx);
        }
        if (parsed.kind === 'PullRequest') {
          const repo = findRepoByDbId(Number(parsed.parts[0]));
          const pull = repo?.pulls.find((entry) => entry.number === Number(parsed.parts[1]));
          if (!repo || !pull) return null;
          return executeSelection(sub, 'PullRequest', { __typename: 'PullRequest', repo, pull }, ctx);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (typeKind(name) === null) return null;
        return executeSelection(sub, '__Type', { __typename: '__Type', name }, ctx);
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
        const repo = parsed?.kind === 'Repository' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve repository id' });
          return null;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const now = nextIso();
        const issue: Issue = {
          id: store.nextIssueId++,
          number: repo.nextIssueNumber++,
          title,
          body,
          state: 'open',
          labels: [],
          comments: [],
          createdAt: now,
          updatedAt: now,
        };
        repo.issues.push(issue);
        return executeSelection(sub, 'CreateIssuePayload', { __typename: 'CreateIssuePayload', repo, issue }, ctx);
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
        const repo = parsed?.kind === 'Issue' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
        const issue = repo?.issues.find((entry) => entry.number === Number(parsed?.parts[1]));
        if (!repo || !issue) {
          ctx.errors.push({ message: 'Could not resolve issue id' });
          return null;
        }
        issue.state = 'closed';
        issue.updatedAt = nextIso();
        return executeSelection(sub, 'CloseIssuePayload', { __typename: 'CloseIssuePayload', repo, issue }, ctx);
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
        const repo = parsed?.kind === 'Repository' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve repository id' });
          return null;
        }
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
        const title = typeof input.title === 'string' ? input.title : '';
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: 'head or base branch does not exist' });
          return null;
        }
        const now = nextIso();
        const pull: Pull = {
          id: store.nextPullId++,
          number: repo.nextPullNumber++,
          title,
          body: typeof input.body === 'string' ? input.body : '',
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
        return executeSelection(sub, 'CreatePullRequestPayload', { __typename: 'CreatePullRequestPayload', repo, pull }, ctx);
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
        const repo = parsed?.kind === 'PullRequest' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
        const pull = repo?.pulls.find((entry) => entry.number === Number(parsed?.parts[1]));
        if (!repo || !pull) {
          ctx.errors.push({ message: 'Could not resolve pull request id' });
          return null;
        }
        const merged = mergePull(repo, pull);
        if (merged.status !== 200) {
          ctx.errors.push({ message: typeof (merged.body as Record<string, unknown>).message === 'string' ? String((merged.body as Record<string, unknown>).message) : 'merge failed' });
          return null;
        }
        return executeSelection(sub, 'MergePullRequestPayload', { __typename: 'MergePullRequestPayload', repo, pull }, ctx);
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
        const repo = parsed?.kind === 'Issue' ? findRepoByDbId(Number(parsed.parts[0])) : undefined;
        const issue = repo?.issues.find((entry) => entry.number === Number(parsed?.parts[1]));
        if (!repo || !issue) {
          ctx.errors.push({ message: 'Could not resolve subject id' });
          return null;
        }
        const body = typeof input.body === 'string' ? input.body : '';
        const now = nextIso();
        const comment = { id: store.nextCommentId++, body, createdAt: now, updatedAt: now };
        issue.comments.push(comment);
        const node = { id: globalId('IssueComment', repo.id, issue.number, comment.id), body };
        return executeSelection(sub, 'AddCommentPayload', { __typename: 'AddCommentPayload', comment: node }, ctx);
      }
      return null;
    }
    case 'User': {
      if (field.name === 'login') return parent.login;
      if (field.name === 'id') return parent.id;
      if (field.name === 'name') return parent.name;
      if (field.name === 'email') return parent.email;
      return null;
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'private': case 'isPrivate': return repo.private;
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'owner': return executeSelection(sub, 'User', { __typename: 'User', login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, ctx);
        case 'defaultBranchRef': return executeSelection(sub, 'Ref', { __typename: 'Ref', name: repo.defaultBranch }, ctx);
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const issue = repo.issues.find((entry) => entry.number === Number(args.number));
          if (!issue) return null;
          return executeSelection(sub, 'Issue', { __typename: 'Issue', repo, issue }, ctx);
        }
        case 'issues': {
          let issues = [...repo.issues];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          if (orderBy.field === 'CREATED_AT') {
            issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
          } else {
            issues.sort((a, b) => a.number - b.number);
          }
          const first = typeof args.first === 'number' ? args.first : 30;
          const afterIndex = decodeCursor(typeof args.after === 'string' ? args.after : null);
          const start = afterIndex + 1;
          const nodes = issues.slice(start, start + first);
          const endIndex = start + nodes.length - 1;
          return buildConnection(sub, ctx, {
            nodes: nodes.map((issue) => ({ __typename: 'Issue', repo, issue }) as RuntimeValue),
            pageInfo: {
              hasNextPage: endIndex + 1 < issues.length,
              hasPreviousPage: start > 0,
              startCursor: nodes.length > 0 ? encodeCursor(start) : null,
              endCursor: nodes.length > 0 ? encodeCursor(endIndex) : null,
            },
            totalCount: issues.length,
          });
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states) {
            const wanted = new Set(states.map((state) => String(state).toUpperCase()));
            pulls = pulls.filter((pull) => wanted.has(pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'));
          } else {
            pulls = pulls.filter((pull) => pull.state === 'open');
          }
          pulls.sort((a, b) => a.number - b.number);
          const first = typeof args.first === 'number' ? args.first : 30;
          const nodes = pulls.slice(0, first);
          return buildConnection(sub, ctx, {
            nodes: nodes.map((pull) => ({ __typename: 'PullRequest', repo, pull }) as RuntimeValue),
            pageInfo: { hasNextPage: nodes.length < pulls.length, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: pulls.length,
          });
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
          if (!pull) return null;
          return executeSelection(sub, 'PullRequest', { __typename: 'PullRequest', repo, pull }, ctx);
        }
        default: return null;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      return null;
    }
    case 'Issue': {
      const issue = parent.issue;
      switch (field.name) {
        case 'id': return issueGlobalId(parent.repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'author': return executeSelection(sub, 'User', { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, ctx);
        case 'url': return `https://example.invalid/${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`;
        case 'labels': {
          const nodes = issue.labels.map((name) => {
            const label = parent.repo.labels.get(name) ?? { name, color: 'ededed', description: '' };
            return { __typename: 'Label', name: label.name, color: label.color, description: label.description } as RuntimeValue;
          });
          return buildConnection(sub, ctx, { nodes, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length });
        }
        case 'comments': {
          const nodes = issue.comments.map((comment) => ({ __typename: 'IssueComment', id: globalId('IssueComment', parent.repo.id, issue.number, comment.id), body: comment.body }) as RuntimeValue);
          return buildConnection(sub, ctx, { nodes, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length });
        }
        default: return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      // Connections are built by buildConnection; this branch is unreachable.
      return null;
    }
    case 'Label': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'color') return parent.color;
      if (field.name === 'description') return parent.description;
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'hasPreviousPage') return parent.hasPreviousPage;
      if (field.name === 'startCursor') return parent.startCursor;
      if (field.name === 'endCursor') return parent.endCursor;
      return null;
    }
    case 'PullRequest': {
      const pull = parent.pull;
      const repo = parent.repo;
      switch (field.name) {
        case 'id': return pullGlobalId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        case 'mergeable': {
          const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
          const headTip = repo.refs.get(`refs/heads/${pull.head}`);
          if (!baseTip || !headTip) return 'UNKNOWN';
          const base = mergeBase(repo, baseTip, headTip);
          if (base === null) return 'UNKNOWN';
          const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
          const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
          const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
          const fromBase = flattenTree(repo, baseTree);
          const fromHead = flattenTree(repo, headTree);
          const fromBaseTip = flattenTree(repo, baseTipTree);
          for (const [path, headEntry] of fromHead) {
            const baseEntry = fromBase.get(path);
            const baseTipEntry = fromBaseTip.get(path);
            if (baseEntry?.oid !== headEntry.oid && baseEntry?.oid !== baseTipEntry?.oid && baseTipEntry?.oid !== headEntry.oid) return 'CONFLICTING';
          }
          for (const [path, baseEntry] of fromBase) {
            if (!fromHead.has(path) && baseEntry.oid !== fromBaseTip.get(path)?.oid) return 'CONFLICTING';
          }
          return 'MERGEABLE';
        }
        case 'files': {
          const files = pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : 30;
          const nodes = files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', file }) as RuntimeValue);
          return buildConnection(sub, ctx, { nodes, pageInfo: { hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: files.length });
        }
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'author': return executeSelection(sub, 'User', { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, ctx);
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'headRef': return executeSelection(sub, 'Ref', { __typename: 'Ref', name: pull.head }, ctx);
        case 'baseRef': return executeSelection(sub, 'Ref', { __typename: 'Ref', name: pull.base }, ctx);
        default: return null;
      }
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return String(parent.file.filename ?? parent.file.path ?? '');
      if (field.name === 'filename') return String(parent.file.filename ?? '');
      if (field.name === 'additions') return Number(parent.file.additions ?? 0);
      if (field.name === 'deletions') return Number(parent.file.deletions ?? 0);
      if (field.name === 'changes') return Number(parent.file.changes ?? 0);
      if (field.name === 'status') return String(parent.file.status ?? '');
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return parent.id;
      if (field.name === 'body') return parent.body;
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return executeSelection(sub, 'IssueComment', { __typename: 'IssueComment', id: parent.comment.id, body: parent.comment.body }, ctx);
      if (field.name === 'cursor') return '';
      return null;
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return executeSelection(sub, 'Issue', { __typename: 'Issue', repo: parent.repo, issue: parent.issue }, ctx);
      return null;
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return executeSelection(sub, 'Issue', { __typename: 'Issue', repo: parent.repo, issue: parent.issue }, ctx);
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return executeSelection(sub, 'PullRequest', { __typename: 'PullRequest', repo: parent.repo, pull: parent.pull }, ctx);
      return null;
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return executeSelection(sub, 'PullRequest', { __typename: 'PullRequest', repo: parent.repo, pull: parent.pull }, ctx);
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return executeSelection(sub, 'IssueCommentEdge', { __typename: 'IssueCommentEdge', comment: parent.comment }, ctx);
      return null;
    }
    case '__Type': {
      const name = parent.name;
      const kind = typeKind(name);
      if (field.name === 'name') return name;
      if (field.name === 'kind') return kind;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        if (kind !== 'OBJECT') return null;
        const fields = (SCHEMA_FIELDS[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }) as RuntimeValue);
        return fields.map((entry) => executeSelection(sub, '__Field', entry, ctx));
      }
      if (field.name === 'enumValues') {
        if (kind !== 'ENUM') return null;
        const values = (SCHEMA_ENUMS[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value }) as RuntimeValue);
        return values.map((entry) => executeSelection(sub, '__EnumValue', entry, ctx));
      }
      return null;
    }
    case '__Field': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      return null;
    }
    default:
      return null;
  }
}

function buildConnection(
  sub: SelectionNode[],
  ctx: ExecContext,
  connection: { nodes: RuntimeValue[]; pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }; totalCount: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of sub) {
    if (selection.kind !== 'field') continue;
    const field = selection.field;
    if (field.name === 'nodes') {
      out[field.alias ?? 'nodes'] = connection.nodes.map((node) => {
        if (node === null) return null;
        return executeSelection(field.selectionSet ?? [], node.__typename, node, ctx);
      });
    } else if (field.name === 'edges') {
      out[field.alias ?? 'edges'] = connection.nodes.map((node) => {
        if (node === null) return null;
        const edgeSelections = field.selectionSet ?? [];
        const edge: Record<string, unknown> = {};
        for (const edgeSelection of edgeSelections) {
          if (edgeSelection.kind !== 'field') continue;
          if (edgeSelection.field.name === 'node') {
            edge[edgeSelection.field.alias ?? 'node'] = executeSelection(edgeSelection.field.selectionSet ?? [], node.__typename, node, ctx);
          } else if (edgeSelection.field.name === 'cursor') {
            edge[edgeSelection.field.alias ?? 'cursor'] = '';
          }
        }
        return edge;
      });
    } else if (field.name === 'pageInfo') {
      out[field.alias ?? 'pageInfo'] = executeSelection(field.selectionSet ?? [], 'PageInfo', { __typename: 'PageInfo', ...connection.pageInfo }, ctx);
    } else if (field.name === 'totalCount') {
      out[field.alias ?? 'totalCount'] = connection.totalCount;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// validation: unknown fields are GraphQL errors, not HTTP errors
// -------------------------------------------------------------------------------------------

function validateSelections(
  selections: SelectionNode[],
  parentType: string,
  ctx: ExecContext,
  fragments: Map<string, FragmentNode>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment) validateSelections(fragment.selectionSet, fragment.typeCondition, ctx, fragments);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      validateSelections(selection.selectionSet, selection.typeCondition ?? parentType, ctx, fragments);
      continue;
    }
    const field = selection.field;
    if (field.name === '__typename') continue;
    const fields = SCHEMA_FIELDS[parentType];
    if (parentType === 'Node') {
      // node(id:) is an interface: only inline fragments name concrete fields.
      if (field.name === 'id') continue;
      continue;
    }
    if (!fields || !fields.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    if (field.selectionSet) {
      const childType = childTypeOf(parentType, field.name);
      if (childType) validateSelections(field.selectionSet, childType, ctx, fragments);
    }
  }
}

function childTypeOf(parentType: string, field: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
    Mutation: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
    Repository: {
      owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
    },
    Issue: { author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection' },
    IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    IssueEdge: { node: 'Issue' },
    PullRequest: { author: 'User', files: 'PullRequestChangedFileConnection', headRef: 'Ref', baseRef: 'Ref' },
    PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
    PullRequestEdge: { node: 'PullRequest' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue' },
    IssueCommentEdge: { node: 'IssueComment' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return map[parentType]?.[field] ?? null;
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function executeOperation(operation: OperationNode, variables: Record<string, unknown>, fragments: Map<string, FragmentNode>): Record<string, unknown> {
  const ctx: ExecContext = { variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(operation.selectionSet, rootType, ctx, fragments);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  const root: RuntimeValue = rootType === 'Mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelection(operation.selectionSet, rootType, root, ctx);
  if (ctx.errors.length > 0) {
    return { data, errors: ctx.errors };
  }
  return { data };
}

/**
 * Execute one GraphQL request body (a single operation object or an array of them).
 * Returns the HTTP status and the JSON body.
 */
export function handleGraphQL(body: unknown): GraphQLReply {
  try {
    if (Array.isArray(body)) {
      const results: unknown[] = [];
      for (const entry of body) {
        if (typeof entry !== 'object' || entry === null) {
          results.push({ data: null, errors: [{ message: 'Invalid operation' }] });
          continue;
        }
        const query = String((entry as Record<string, unknown>).query ?? '');
        const variables = ((entry as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
        const operationName = (entry as Record<string, unknown>).operationName as string | undefined;
        results.push(executeDocument(query, variables, operationName));
      }
      return { status: 200, body: results };
    }
    if (typeof body !== 'object' || body === null) {
      return { status: 400, body: { message: 'GraphQL body must be a JSON object' } };
    }
    const query = String((body as Record<string, unknown>).query ?? '');
    const variables = ((body as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    const operationName = (body as Record<string, unknown>).operationName as string | undefined;
    return { status: 200, body: executeDocument(query, variables, operationName) };
  } catch (err) {
    return { status: 400, body: { errors: [{ message: err instanceof Error ? err.message : String(err) }] } };
  }
}

function executeDocument(query: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  const { operations, fragments } = new Parser(lex(query)).parseDocument();
  let operation = operations[0];
  if (operationName !== undefined) {
    operation = operations.find((candidate) => candidate.name === operationName) ?? operations[0];
  }
  if (!operation) return { data: null, errors: [{ message: 'No operation found' }] };
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (mergedVariables[variable.name] === undefined && variable.defaultValue !== undefined) {
      mergedVariables[variable.name] = resolveValue(variable.defaultValue, variables);
    }
  }
  return executeOperation(operation, mergedVariables, fragments);
}
