# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Adnanking-king/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Adnanking-king/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process (TypeScript, standard library only, no dependencies, no git binary): git smart HTTP (protocol v0 and v2, shallow clones and deepen), REST v3 (repositories, branches, commits, contents, issues, pull requests with squash merge), GraphQL v4 (viewer, repository, issues and pull-request connections, mutations, `__type` introspection) and MCP over streamable HTTP (create/list repos, issues and pull requests). Objects are stored in memory with byte-exact SHA-1 packs, deterministic timestamps for replay, and Bearer-token auth on every API surface except `/healthz`.

## Run it

```sh
node --experimental-strip-types main.ts
```

The harness provides `MAKEFUN_ENV_URL` (the env to register with) and `MAKEFUN_SHOP_TOKEN` (the Bearer token every API call carries). The entry binds an ephemeral port, registers it, and exits when the env says the trial is done. For a local smoke test, point `MAKEFUN_ENV_URL` at any dummy origin and set `MAKEFUN_SHOP_TOKEN` to any token; `/healthz` answers `{"ok":true}` without auth.

---

<sub>Entered on [make.fun](https://make.fun/?ref=v9pvyfm7&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
