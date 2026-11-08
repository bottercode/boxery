# Working on boxery (agents)

boxery gives coding agents VMs: a CLI (`boxery`), an MCP server and a pi extension on the agent's machine, and `boxery-host` on the machine that runs the VMs. [README](README.md) says what it does, [ARCHITECTURE.md](ARCHITECTURE.md) how, and [CONTRIBUTING.md](CONTRIBUTING.md) how to test it. This file is the short version for agents; where they overlap, CONTRIBUTING.md is the reference.

## Map

| Path | What |
|---|---|
| `core/` | Shared by the CLI, MCP and pi: the `vm_*` tool table (`boxery-tools.mjs`), ssh transport and tools (`boxery-core.mjs`), lifecycle, leases, grants, profiles, copies. `core/*.ts` is piped into the VM |
| `controller/` | The `boxery` CLI: `boxery` (Bash shim) → `cli.mjs` (the `COMMANDS` table, each with its help) |
| `mcp/`, `extension/` | The two agent front-ends, both built from `core/boxery-tools.mjs` |
| `host/` | `boxery-host`: Bash entry, Node everywhere else; `host/backends/*.sh` are the hypervisor backends ([contract](host/backends/README.md)), `fake.sh` the test double |
| `backends/`, `guests/`, `help/` | Data and renderers both sides load: backend declarations, guest OS paths, CLI help. They import nothing |
| `proxy/` | Credential proxy on the host |
| `image/` | What boxery adds to Ubuntu (`layers/*.sh`, cloud-config) |
| `test/` | `*.test.mjs` (`node --test`), `shell/*.sh` (against the fake backend), `fixtures/`, `bench/` |
| `evals/` | Agent behaviour evals (own `package.json`; spends tokens) |
| `docs/` | User docs; `plans/` (dated designs), `reviews/`, `research/`, `brand/`, `diagrams/`, `promo/` |
| `scripts/docs-cli.mjs` | Regenerates the command reference in `docs/cli.md` |

## Rules of the code

- No build step and no runtime dependencies. The `.mjs` files are plain JavaScript typed with JSDoc and checked by `tsc` (`strict`, `checkJs`); they ship as written. Don't convert them to TypeScript. Only `core/*.ts` is TypeScript, and it must stay erasable (it runs under type stripping in the VM).
- Node ≥ 22.13 everywhere (`package.json` `engines`).
- What is still Bash (`controller/boxery`, `host/boxery-host`, `host/backend.sh`, `host/backends/*.sh`, `core/boxery-job-runner.sh`, sourced profile configs) must run under macOS's bash 3.2: no `declare -A`, `mapfile`, `${x,,}`, `wait -n`.
- Boundaries: `host/` never imports `core/` ([host modules](docs/host-modules.md)); `core/`, `mcp/` and `extension/` never reach into `controller/` (`test/frontends.test.mjs`); `backends/`, `guests/` and `help/` import nothing.
- Output formats are a contract: `boxery-host` output is pinned by `test/shell/host-output.sh`, and the CLI's by `docs/cli.md` and `test/fixtures/boxery-help.txt`.
- Match the surrounding code: short comments that say why, the same naming, tabs.

## When you add or change something

Adding a `vm_*` tool, a `boxery` or `boxery-host` command or flag, a backend, a shell test or a source directory means changing more than one file. Follow the checklist in [CONTRIBUTING.md](CONTRIBUTING.md#when-you-add-or-change-something) and update the docs that describe the behaviour in the same change.

## Before you say it's done

```bash
npm run lint && npm run typecheck && npm test && npm run test:shell
```

`npm run typecheck` needs `npm i --no-save typescript@5.9.3 @types/node@22` first. Run what you can, and say which checks you didn't run. Before calling a test flaky, check whether the machine is short of CPU, memory or disk.

## Tests stay offline

- Offline tests use only their own temporary directories (`mktemp -d`, `mkdtempSync`). Never point a test at a real `BOXERY_HOME`, `~/.config/boxery` or a real host.
- Shell tests stub `launchctl` and `systemctl`; `test/shell/run.sh` fails any test that reaches the real ones.
- Live checks touch real hosts and VMs or spend tokens: `./e2e.sh`, `mcp/test-mcp.sh`, `test/openshell-smoke.mjs`, `test/bench/vm-startup.mjs`, `evals/`. Run them only when the user asks. On a shared host, registering it is not acquiring a lease: take any lease the host requires first.
- Grants need a person at a terminal (`/dev/tty`). Don't set `GRANT_CONFIRM=off` in someone's real profile to get past a prompt.

## Git and pull requests

- Branch from `master`; commit and PR titles as in [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests).
- `master` has no required checks: `gh pr merge --auto` merges at once. Wait for CI to pass yourself before merging.
- CI skips changes that touch only `*.md`, `docs/` or `LICENSE`, so run the drift tests yourself after a docs change (`node --test test/help-drift.test.mjs test/backend-capabilities.test.mjs`).
- Keep private things out of public changes: hostnames, credentials, local agent task files, private app recipes.

## Skills

`.claude/skills/promo-video/` is how the promo video in `docs/promo/` is made and reviewed.
