# Working on boxery (agents)

boxery gives coding agents VMs. [ARCHITECTURE.md](ARCHITECTURE.md) explains how it fits together and [CONTRIBUTING.md](CONTRIBUTING.md) how to test it; read them before a change that crosses parts. This file is how to work here.

## One implementation, several front-ends

The CLI, the MCP server and the pi extension are front-ends over the same core. Put behaviour in the core so all three get it, and give a front-end only what is truly its own (argument parsing, the terminal, a client's dialog). Tests fail when a tool or command exists on one side only; when that happens, map it to its counterpart or say why it has none, rather than silencing the test.

## No build step, no dependencies

boxery runs straight from an npm install or a checkout. Node won't strip TypeScript types from files under `node_modules`, so the shipped code is plain JavaScript typed with JSDoc comments and checked by `tsc`. The one TypeScript exception is code piped into the VM and run under type stripping, which is why it must stay erasable. If a change seems to need a dependency or a build, raise it with the user instead of adding one.

## Node and Bash

Logic lives in Node. Bash is used where it does a job better, and each place has a reason:

- **Entry shims** (`boxery`, `boxery-host`) run before Node does: they find the right Node over a non-interactive ssh, resolve npm's symlinks, and pass arguments on byte for byte.
- **`connect`** is the ssh ProxyCommand for every new VM connection. Starting Node there would add about 50 ms to each one, so it stays a Bash fast path to `nc`.
- **Backends** are thin wrappers around hypervisor CLIs (`virsh`, `limactl`, ssh), one function per process, with arguments as argv. When a backend needs JSON or HTTP, it calls a Node helper (as boat's REST client does) instead of growing shell.
- **The job runner** is sent into the VM with each job. It only keeps the job alive in its own process group and records its real exit code, and a shell does that without a Node process per job.

These must run under bash 3.2. On macOS (controllers, Lima hosts) `/bin/bash` is 3.2, and over a non-interactive ssh it is usually the bash on PATH. CI checks them under 3.2.

None of this is fixed. When a reason stops holding or a better one appears, moving code between Bash and Node is fine. Say why in the PR, keep the contract it serves (argv, output, exit codes) and the tests that pin it, and update the docs that explain the split ([host modules](docs/host-modules.md), the [host-in-Node plan](docs/plans/2026-11-01-host-orchestration-in-node.md)). What to avoid is putting new logic in Bash just because the file you are in is Bash.

## Boundaries and contracts

The host and the agent side run on different machines and can be at different versions. So the host doesn't import the agent-side core; they share only small modules that import nothing (backend declarations, guest OS facts, help rendering). The core and the agent front-ends never call into the CLI.

Output formats, the backend contract and the operation journal are read by other code, sometimes code at another version. Change them on purpose, with their tests and docs, never as a side effect.

## Working

- Keep the docs that describe a behaviour in the same change as the behaviour. Adding a tool, command, flag, backend, shell test or source directory touches several files: follow the [checklist](CONTRIBUTING.md#when-you-add-or-change-something).
- Before saying you're done, run `npm run lint && npm run typecheck && npm test && npm run test:shell` (typecheck setup is in CONTRIBUTING.md). Say which checks you didn't run.
- Before calling a test flaky, check whether the machine is short of CPU, memory or disk.
- Match the code around you: short comments that say why, the same naming, tabs.

## Tests stay offline

- Offline tests use only their own temporary directories. Never point one at a real `BOXERY_HOME`, `~/.config/boxery` or a real host.
- Shell tests stub the service managers (`launchctl`, `systemctl`); the runner fails any test that reaches the real ones.
- Live checks (the e2e script, the MCP protocol test, the OpenShell smoke test, VM benchmarks, evals) create real VMs or spend tokens. Run them only when the user asks. On a shared host, registering it is not acquiring a lease: take any lease the host requires first.
- Grants need a person at a terminal. Don't turn grant confirmation off in someone's real profile to get past a prompt.

## Git and pull requests

- Branch from `master`; titles follow [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests).
- `master` has no required checks, so `gh pr merge --auto` merges at once. Wait for CI to pass yourself.
- CI skips changes that touch only Markdown, `docs/` or `LICENSE`, yet some tests check docs. After a docs change, run `node --test test/help-drift.test.mjs test/backend-capabilities.test.mjs` yourself.
- Keep private things out of public changes: hostnames, credentials, local agent task files, private app recipes.
