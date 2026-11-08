# Pushing a checkout with `vm_sync` and `boxery sync`

← [Docs](README.md)

`vm_sync` makes a VM's copy of a git checkout match your local one exactly: the same commit, plus your staged, unstaged and untracked changes. Agents edit locally and run code in the VM; one sync before each run keeps the VM current, without giving the VM GitHub access or carrying patches by hand. It only pushes: nothing comes back from the VM, and there is no watch mode.

```bash
boxery sync demo                          # the checkout you're in → demo:~/project
boxery sync demo --from ../api --to ~/api # another checkout → demo:~/api
boxery sync demo --json                   # the result as JSON
```

```json
{"vm":"demo"}
{"vm":"demo","from":"../api","to":"~/api"}
```

`from` is a local directory inside the checkout (default: the agent's working directory, or the CLI's current directory); the whole repository is synced from its root. `to` is the VM directory (default `~/project`; relative paths are under it). `boxery sync` runs `vm_sync`'s own code ([CLI](cli.md#files)).

## What it does

1. **Snapshot.** It records local HEAD plus every working change (what `git add -A` would stage: tracked files, and untracked files `.gitignore` doesn't exclude, deletions and renames included) as one commit. It uses a scratch index and object directory: your index, refs and stash are untouched. The commit has a fixed author and date, so the same working state always gives the same commit.
2. **Transfer.** The commits the VM lacks go over as a `git bundle`, on the same streaming transport as [`vm_copy`](copy.md). Neither side contacts a git remote, so the VM needs no GitHub grant. If the VM already has the snapshot, nothing is sent. If `to` doesn't exist or is empty, a repository is initialized there.
3. **Swap.** In the VM, HEAD is detached at local HEAD's commit, and the working directory is switched to the snapshot: only the paths that differ are rewritten, and files the snapshot lacks are deleted, including ones an earlier sync put there. Ignored files (`node_modules`, build output) stay: there is no `git clean -x`. If the snapshot would put a tracked file where the VM has an ignored one, the sync refuses instead (below). The VM's index holds HEAD, so `git status` and `git diff` in the VM show the same working changes as they do locally.
4. **Check.** Both sides hash the whole working directory (tracked plus untracked, not ignored) as a git tree, the same way, and compare. The result says `tree matches`, or `TREE MISMATCH` (an error).

```text
synced 3f2a9c1 + 2 modified, 1 untracked, 0 deleted → demo:/home/agent/project · tree matches
```

Structured fields: `sha` (local HEAD), `snapshot`, `counts` (`modified`, `untracked`, `deleted`), `tree` (`local`, `vm`, `match`), `lockfile_changed`, `transferred_bytes`, `elapsed_ms`.

`lockfile_changed` is true when `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` or `bun.lock` (at any depth) differs from the previous sync, or from the VM's HEAD on the first one. vm_sync installs nothing; run your install step when it says so.

A second sync with no local changes sends nothing and still reports `tree matches`.

## When it refuses

It refuses, and changes nothing in the VM, when:

- **The VM checkout has changes the last sync didn't make.** The VM records each sync in `refs/boxery/synced` (and local HEAD in `refs/boxery/base`). Any difference between the VM's working directory and that snapshot (edited, new or deleted files, not ignored ones) is listed in the error. Commit them in the VM and bring them back yourself, or discard them, then sync again. A VM repository that was never synced is compared with its HEAD.
- **The checkout holds a credential file.** Matched case-insensitively: `.env` and `.env.*`/`.env-*`/`.env_*` (except `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.defaults`), `.envrc`, `.npmrc`, `.yarnrc.yml`, `.pypirc`, `.netrc`, `.git-credentials`, `.pgpass`, `.my.cnf`, `.terraformrc`, `auth.json`, `credentials`, `application_default_credentials.json`, private keys (`id_*` except `.pub`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`), `.docker/config.json`, `.kube/config`, `.aws/config`, `gh/hosts.yml`, and anything inside boxery's own state or `~/.ssh`, `~/.gnupg`, `~/.pi` (what `vm_copy` refuses). The error names the path. Ignore it in `.gitignore` to sync the rest, and get the credential to the VM with a [grant](grants.md), which keeps it off the VM's disk and out of its snapshots. Ignored files are never synced, so an ignored `.env` is fine.
- **The commits it would send contain one.** The bundle carries every commit the VM lacks (on a first sync, the whole history), so a credential file committed once and deleted later is refused too. Remove it from history first.
- **The local checkout now tracks a path the VM has as an ignored file** (a force-added build file, or `dist/` un-ignored and replaced by a file): the swap would overwrite or delete the VM's file. Or, with the new `.gitignore`, **files the VM has stop being ignored**, so the trees can't match. The error lists the paths; remove them in the VM (or change the local checkout), and sync again.
- **`to` is a non-empty directory that isn't a git repository**, is inside another checkout (`~/project/api` when `~/project` is a repository: use `~/api`), or its object format (sha1/sha256) differs.
- **The local path isn't a git checkout**, has no commits yet, or is a shallow clone. Use `vm_copy` for plain files.

"Nothing changed" means the checkout: a refused first sync into an empty or missing directory may leave it as an empty repository.

## Cancellation and failure

Cancelling (an MCP cancellation, pi's Escape, Ctrl-C for `boxery sync`) before the transfer finishes leaves the VM unchanged: the partial bundle is removed with `vm_copy`'s staging. Once the VM starts applying, it ignores signals and finishes or rolls back; a lost connection doesn't interrupt it, and `boxery sync` waits for its result after Ctrl-C.

The swap is staged: the VM fetches the bundle into its object store (which changes no files), then writes a pending record, switches the working directory, and finally updates HEAD and its refs in one transaction. If a step fails, it switches back and restores the index. If the VM crashes mid-swap, the next sync finds the pending record and finishes it (if the refs were written) or undoes it, before checking for VM-side changes. It undoes it only if every file is as the swap left it; a file edited since is reported, and the record stays. Fetched objects stay in the VM's repository either way; they're harmless and `git gc` collects them.

A sync takes a lock in the VM repository (`flock`, or a lock directory without it), so two syncs into one checkout run one after the other. If the checkout changes between the check and the swap, the sync refuses: git checks every path before writing any.

## Limits

- Needs git (2.31+) on both sides; boxery's images have it.
- Submodules are synced as gitlinks (their commit ids), not their contents.
- Git LFS files arrive as pointer files: the VM doesn't download them, since vm_sync never contacts a remote.
- Untracked files are hashed into a temporary directory on the local machine, so a very large one needs that much space there.
- Executable bits and symlinks follow git's rules; other file modes, owners and timestamps aren't carried.
- The VM keeps every synced snapshot's objects until `git gc`.
- On an HTTP MCP server, `vm_sync` reads checkouts on that server, so it follows `vm_copy`'s `local:` rule: refused without `--copy-root`, and confined to `DIR` with it ([MCP server](mcp.md#b-streamable-http-on-the-host-over-tailscale)). Confined, the repository's git directory, object store and alternates must be inside `DIR` too, git doesn't look for a repository above `DIR`, and it runs none of the checkout's hooks, fsmonitor or filter drivers.
