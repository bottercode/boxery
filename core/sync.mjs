// vm_sync: push the caller's local git checkout into a VM, so the VM's tree matches it exactly (docs/sync.md).
// Commits travel as a git bundle over vm_copy's streaming transport (copy-stream.mjs); neither side ever
// contacts a git remote. The VM side is core/sync-guest.sh, sent with every call. The local repository
// is only read: the snapshot of its working changes is built in a scratch index and object directory.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { q } from "./shell.mjs";
import { streamCopy } from "./copy-stream.mjs";
import { PROJECT, REMOTE_HOME, assertName, confineLocal, currentHost, deniedDirs, isWithin, sshRun, vmPath } from "./boxery-core.mjs";
/** @import { LocalConfinement, ToolResult } from "./boxery-core.mjs" */
/** @typedef {{ from?: string, to?: string }} SyncParams */
/** @typedef {{ localCwd?: string, local?: LocalConfinement | false, signal?: AbortSignal }} SyncOpts */
/** What the VM reported (sync-guest.sh probe, or apply's tree and lockfile_changed). @typedef {{ state: string, format?: string, synced?: string, base?: string, head?: string, has?: string, pending?: string, baseline?: string, worktree?: string, tree?: string, lockfile_changed?: string, changed: string[], entry: string[] }} Probe */

const guestTemplate = readFileSync(new URL("./sync-guest.sh", import.meta.url), "utf8");

export const SYNC_DISABLED =
	"vm_sync is disabled on this server: it runs on the boxery control plane, so a local checkout would be that machine's files, not yours. " +
	"Ask the user to start the server with --copy-root DIR to allow syncing checkouts inside DIR, or sync from a stdio MCP server or pi on your own machine.";

/** Lockfiles whose change means the VM's dependencies need installing again. */
export const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"];

// Credentials vm_sync never puts on a VM's disk (and so into its snapshots): the agent asks with vm_grant instead.
// Case-insensitive. Templates (.env.example, .env.sample, .env.template, .env.dist) hold no values and are allowed.
const ENV_TEMPLATE = /^\.env[._-](example|sample|template|dist|defaults)$/i;
const DENY_NAME = new RegExp("^(" + [
	"\\.env([._-].*|rc)?", "\\.npmrc", "\\.yarnrc\\.yml", "\\.pypirc", "\\.netrc", "_netrc", "\\.git-credentials", "\\.pgpass", "\\.my\\.cnf",
	"\\.dockercfg", "\\.s3cfg", "\\.boto", "\\.terraformrc", "auth\\.json", "credentials(\\.json)?", "application_default_credentials\\.json",
	"id_[a-z0-9_-]+", ".*\\.(pem|key|p12|pfx|jks|keystore)",
].join("|") + ")$", "i");
const DENY_PATH = /(^|\/)(\.docker\/config\.json|\.kube\/config|gh\/hosts\.yml|\.aws\/config)$/i;
/** Is a repository path a credential file vm_sync refuses? @param {string} p */
export function deniedSyncPath(p) {
	const name = path.posix.basename(p);
	if (ENV_TEMPLATE.test(name) || /\.pub$/i.test(name)) return false;
	return DENY_NAME.test(name) || DENY_PATH.test(p);
}

const IDENTITY = { GIT_AUTHOR_NAME: "boxery sync", GIT_AUTHOR_EMAIL: "sync@boxery.invalid", GIT_AUTHOR_DATE: "@0 +0000" };
const COMMITTER = { GIT_COMMITTER_NAME: IDENTITY.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: IDENTITY.GIT_AUTHOR_EMAIL, GIT_COMMITTER_DATE: IDENTITY.GIT_AUTHOR_DATE };
// Repository-locating variables from the caller's environment would point git elsewhere.
const GIT_LOCATION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"];
// No lazy fetches from a partial clone's promisor remote: vm_sync never contacts a remote.
const baseEnv = () => {
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
	for (const k of GIT_LOCATION) delete env[k];
	return env;
};
// A confined server (HTTP MCP with --copy-root) reads a checkout an agent may have written: git must not
// run anything that checkout's config names (fsmonitor, hooks, filter drivers) or look outside the root.
const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never"];
const aborted = () => Object.assign(new Error("sync aborted; the VM was not changed"), { name: "AbortError" });

/** Run git locally → stdout. @param {string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts] @returns {Promise<string>} */
function git(args, { cwd, env = baseEnv() } = {}) {
	return new Promise((resolve, reject) => {
		execFile("git", [...SAFE_CONFIG, ...args], { cwd, env, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
			if (!error) return resolve(stdout);
			const e = /** @type {NodeJS.ErrnoException} */ (error);
			reject(new Error(e.code === "ENOENT" ? "git is not installed on this machine" : `git ${args[0]}: ${stderr.trim() || e.message}`));
		});
	});
}
const tryGit = (/** @type {string[]} */ args, /** @type {{ cwd?: string, env?: NodeJS.ProcessEnv }} */ opts) => git(args, opts).then((s) => s.trim(), () => null);

/** key=value lines from sync-guest.sh. Repeated keys (changed, entry) collect into arrays. @param {string} out @returns {Probe} */
function parseLines(out) {
	/** @type {any} */
	const r = { changed: [], entry: [] };
	for (const line of out.split("\n")) {
		const i = line.indexOf("=");
		if (i <= 0) continue;
		const k = line.slice(0, i), v = line.slice(i + 1);
		if (Array.isArray(r[k])) r[k].push(v);
		else r[k] = v;
	}
	return r;
}

/** Run sync-guest.sh in `vm` with `vars`. Exit 3 is a refusal: nothing changed. @param {string} vm @param {Record<string, string>} vars */
async function guest(vm, vars) {
	const assignments = Object.entries(vars).map(([k, v]) => `${k}=${q(v)}`).join("\n");
	// No signal: probe is short, and apply must finish or roll back once started (it ignores signals itself).
	// Detached: a terminal's Ctrl-C reaches the whole foreground group; ssh must survive it to report the result.
	const r = await sshRun(vm, `${assignments}\n${guestTemplate}`, { detached: true });
	const err = r.stderr.trim();
	if (r.code === 3) throw new Error(`vm_sync refused: ${err}; nothing in the VM was changed`);
	if (r.code !== 0) {
		if (/git: (command )?not found/.test(err)) throw new Error(`git is not installed in VM "${vm}"`);
		throw new Error(`vm_sync failed in VM "${vm}": ${err || `exit ${r.code}`}`);
	}
	return parseLines(r.stdout.toString("utf8"));
}

/**
 * Confined (--copy-root): the repository's root, git directory, common directory, object store and its
 * alternates must all be inside the root and clear of denied directories, and its config must name no
 * filter driver (git add would run it). Checked before git reads the working tree.
 * @param {string} from @param {ReturnType<typeof confineLocal>} confined @param {NodeJS.ProcessEnv} env
 */
async function checkConfinedRepo(from, confined, env) {
	const out = await tryGit(["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--git-path", "objects"], { cwd: from, env });
	if (!out) return;
	const dirs = out.split("\n").filter(Boolean);
	const objects = dirs[dirs.length - 1];
	let alternates = "";
	try { alternates = readFileSync(path.join(objects, "info", "alternates"), "utf8"); } catch {}
	for (const a of alternates.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) dirs.push(path.resolve(objects, a));
	for (const d of dirs) {
		let real;
		try { real = await realpath(d); } catch { continue; }
		confined.check(real, `${from} (its repository uses ${d})`);
	}
	const filters = await tryGit(["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], { cwd: from, env });
	if (filters) throw new Error(`vm_sync refused: the repository at ${from} configures a git filter driver (${filters.split("\n")[0]}), which this server won't run`);
}

/**
 * The local checkout: repository root, HEAD, and a snapshot commit of HEAD plus every working change
 * (staged, unstaged, untracked but not ignored), built without changing the repository.
 * @param {string} from @param {string} scratch @param {ReturnType<typeof confineLocal> | null} confined
 */
async function snapshot(from, scratch, confined) {
	const env0 = baseEnv();
	if (confined) {
		// Don't discover a repository above the root.
		env0.GIT_CEILING_DIRECTORIES = path.dirname(confined.root);
		await checkConfinedRepo(from, confined, env0);
	}
	const g0 = { env: env0 };
	const top = await tryGit(["rev-parse", "--show-toplevel"], { cwd: from, ...g0 });
	if (!top) {
		const bare = await tryGit(["rev-parse", "--is-bare-repository"], { cwd: from, ...g0 });
		if (bare === "true") throw new Error(`${from} is a bare git repository; vm_sync pushes a checkout with a working tree`);
		throw new Error(`${from} is not a git checkout (no repository found there or above it). vm_sync pushes a git checkout; use vm_copy for other files.`);
	}
	const root = await realpath(top);
	confined?.check(root);
	const head = await tryGit(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: root, ...g0 });
	if (!head) throw new Error(`${root} has no commits yet; commit once before syncing (vm_sync needs a HEAD to check out)`);
	if (await tryGit(["rev-parse", "--is-shallow-repository"], { cwd: root, ...g0 }) === "true")
		throw new Error(`${root} is a shallow clone; vm_sync sends history the VM lacks and can't from a shallow one. Run git fetch --unshallow first`);
	const format = (await git(["rev-parse", "--show-object-format"], { cwd: root, ...g0 })).trim();
	const objects = (await git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], { cwd: root, ...g0 })).trim();
	const index = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: root, ...g0 })).trim();
	const scratchObjects = path.join(scratch, "objects");
	await mkdir(scratchObjects);
	const scratchIndex = path.join(scratch, "index");
	let haveIndex = true;
	try { await writeFile(scratchIndex, readFileSync(index)); } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw e; haveIndex = false; }
	const env = { ...env0, GIT_INDEX_FILE: scratchIndex, GIT_OBJECT_DIRECTORY: scratchObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
	if (!haveIndex) await git(["read-tree", "HEAD"], { cwd: root, env });
	await git(["add", "-A"], { cwd: root, env });
	const tree = (await git(["write-tree"], { cwd: root, env })).trim();
	const headTree = (await git(["rev-parse", "HEAD^{tree}"], { cwd: root, ...g0 })).trim();
	// Deterministic (fixed identity and date), so the same working changes give the same commit every time.
	const snap = tree === headTree ? head
		: (await git(["commit-tree", tree, "-p", head, "-m", "boxery sync: working changes"], { cwd: root, env: { ...env, ...IDENTITY, ...COMMITTER } })).trim();
	const counts = { modified: 0, untracked: 0, deleted: 0 };
	if (tree !== headTree) {
		const tracked = new Set((await git(["ls-files", "-z"], { cwd: root, ...g0 })).split("\0"));
		const fields = (await git(["diff-tree", "-r", "-z", "-M", "--name-status", headTree, tree], { cwd: root, env })).split("\0").filter(Boolean);
		for (let i = 0; i < fields.length;) {
			const status = fields[i++];
			const paths = status.startsWith("R") || status.startsWith("C") ? [fields[i++], fields[i++]] : [fields[i++]];
			if (status === "D") counts.deleted++;
			else if (status === "A" && !tracked.has(paths[0])) counts.untracked++;
			else counts.modified++;
		}
	}
	const files = (await git(["ls-tree", "-r", "-z", "--name-only", tree], { cwd: root, env })).split("\0").filter(Boolean);
	return { root, head, format, objects, scratchObjects, env, tree, snap, counts, files, headTree };
}

/**
 * Refuse credentials: a deny-listed file name anywhere in the tree, or anything in boxery's own state or
 * the user's key directories (what vm_copy refuses), even where the checkout contains one of those.
 * @param {string} root @param {string[]} files @param {string[]} [deny]
 */
function refuseCredentials(root, files, deny) {
	const named = files.filter(deniedSyncPath);
	if (named.length)
		throw new Error(`vm_sync refused: ${named.slice(0, 5).join(", ")}${named.length > 5 ? ` (+${named.length - 5} more)` : ""} in ${root} looks like a credential file, which vm_sync never puts on a VM's disk (it would persist in its snapshots). ` +
			"Ignore it in .gitignore (or remove it, and git rm it if tracked) to sync the rest, and ask for the credential with vm_grant. Nothing in the VM was changed.");
	for (const { dir } of deniedDirs(deny)) {
		if (isWithin(root, dir)) throw new Error(`vm_sync refused: ${root} is inside ${dir} (boxery's own configuration or the user's keys), which vm_sync never copies; use vm_grant for credentials`);
		if (!isWithin(dir, root)) continue;
		const rel = path.relative(root, dir).split(path.sep).join("/");
		const hit = files.find((f) => isWithin(f, rel));
		if (hit) throw new Error(`vm_sync refused: ${path.join(root, hit)} is inside ${dir} (boxery's own configuration or the user's keys), which vm_sync never copies; ignore it in .gitignore, and use vm_grant for credentials`);
	}
}

/**
 * A bundle of the commits the VM lacks (null when it has the snapshot already), excluding what it has.
 * @param {Awaited<ReturnType<typeof snapshot>>} s @param {Probe} probe @param {string} scratch @param {string} id
 */
async function bundle(s, probe, scratch, id) {
	if (probe.has === "1") return null;
	// A bare repository whose alternates are the scratch objects and the checkout's: refs/heads/sync can
	// be written there without touching the checkout's refs.
	const bare = path.join(scratch, "bundle.git");
	const env = baseEnv();
	await git(["init", "-q", "--bare", `--object-format=${s.format}`, bare], { env });
	await writeFile(path.join(bare, "objects", "info", "alternates"), `${s.scratchObjects}\n${s.objects}\n`);
	await git(["--git-dir", bare, "update-ref", "refs/heads/sync", s.snap], { env });
	const have = [];
	for (const c of new Set([probe.synced, probe.base, probe.head].filter(Boolean)))
		if (await tryGit(["--git-dir", bare, "cat-file", "-e", `${c}^{commit}`], { env }) !== null) have.push(`^${c}`);
	// The bundle carries every commit the VM lacks, not just the snapshot: refuse a credential anywhere in them.
	const history = (await git(["--git-dir", bare, "log", "--format=", "--name-only", "--no-renames", "-z", "refs/heads/sync", ...have], { env })).split("\0").map((p) => p.trim()).filter(Boolean);
	const leaked = [...new Set(history.filter(deniedSyncPath))];
	if (leaked.length)
		throw new Error(`vm_sync refused: ${leaked.slice(0, 5).join(", ")} is in the history this sync would send (a commit the VM lacks has it), and vm_sync never puts credential files on a VM's disk. ` +
			"It's not in your working tree, but its old contents are in that commit. Remove it from history (git rebase / git filter-repo) before syncing, and ask for the credential with vm_grant. Nothing in the VM was changed.");
	const file = path.join(scratch, "out", `sync-${id}.bundle`);
	await mkdir(path.dirname(file));
	try {
		await git(["--git-dir", bare, "bundle", "create", "-q", file, "refs/heads/sync", ...have], { env });
	} catch (e) {
		// "empty bundle": everything is reachable from what the VM has; send the snapshot whole instead.
		if (!have.length || !/empty bundle/.test(/** @type {Error} */ (e).message)) throw e;
		await git(["--git-dir", bare, "bundle", "create", "-q", file, "refs/heads/sync"], { env });
	}
	return file;
}

/**
 * vm_sync / boxery sync: make the VM checkout at `to` (default ~/project) match the local checkout at
 * `from` (default the caller's cwd) exactly: HEAD detached at the same commit, plus every working change.
 * `local` is vm_copy's local: policy (undefined: unrestricted; false: refused; {root, deny}: confined).
 * @param {string} vm @param {SyncParams} params @param {SyncOpts} [opts] @returns {Promise<ToolResult>}
 */
export async function syncTool(vm, { from, to } = {}, { localCwd = process.cwd(), local, signal } = {}) {
	const started = Date.now();
	assertName(vm);
	if (local === false) throw new Error(SYNC_DISABLED);
	const fromSpec = String(from ?? ".").replace(/^local:/, "") || ".";
	const confined = local ? confineLocal(local) : null;
	const fromPath = confined ? confined.source(fromSpec) : path.resolve(localCwd, fromSpec.replace(/^~(?=\/|$)/, homedir()));
	const dest = vmPath(to ?? PROJECT);
	if (dest === "/") throw new Error("vm_sync can't sync into the VM's filesystem root");
	const host = currentHost();
	const label = `${vm}:${dest}`;
	if (signal?.aborted) throw aborted();
	const id = randomBytes(8).toString("hex");
	const scratch = await mkdtemp(path.join(tmpdir(), "boxery-sync-"));
	const remoteBundle = `${REMOTE_HOME}/.cache/boxery/sync-${id}.bundle`;
	let sent = false;
	try {
		const s = await snapshot(fromPath, scratch, confined);
		refuseCredentials(s.root, s.files, local ? local.deny : undefined);
		if (signal?.aborted) throw aborted();
		const probe = await guest(vm, { MODE: "probe", DIR: dest, WANT: s.snap });
		if (probe.state === "dir")
			throw new Error(`vm_sync refused: ${label} is not a git repository and is not empty (${probe.entry.join(", ")}…); sync into an empty or new directory (to), or move those files away. Nothing in the VM was changed.`);
		if (probe.state === "repo" && probe.format && probe.format !== s.format)
			throw new Error(`vm_sync refused: the repository at ${label} uses ${probe.format} object ids and the local one ${s.format}`);
		if (probe.state === "repo" && probe.pending !== "1" && probe.worktree !== probe.baseline) {
			const what = probe.synced ? "since the last sync" : "against its HEAD";
			throw new Error(`vm_sync refused: ${label} has changes ${what} that vm_sync didn't make:\n${probe.changed.map((c) => `  ${c.replace("\t", " ")}`).join("\n")}\n` +
				"Commit them in the VM and bring them back yourself, or discard them (git -C DIR stash -u, or checkout/clean), then sync again. Nothing in the VM was changed.");
		}
		const file = await bundle(s, probe, scratch, id);
		let bytes = 0;
		if (file) {
			sent = true;
			bytes = await streamCopy({ path: file, label: "local" }, { path: remoteBundle, vm, sshConf: host.sshConf, label: `${host.name}/${vm}` }, { signal });
		}
		// The last point to stop: past here the VM applies the snapshot completely or not at all.
		if (signal?.aborted) throw aborted();
		const applied = await guest(vm, {
			MODE: "apply", DIR: dest, FORMAT: s.format, BUNDLE: file ? remoteBundle : "", SNAP: s.snap, HEAD_SHA: s.head, TREE: s.tree,
			EXPECT_SYNCED: probe.synced ?? "", EXPECT_HEAD: probe.head ?? "",
		});
		sent = false; // apply removed the bundle
		const match = applied.tree === s.tree;
		const lockfileChanged = applied.lockfile_changed === "1";
		const short = s.head.slice(0, 7), { modified, untracked, deleted } = s.counts;
		const text = `synced ${short} + ${modified} modified, ${untracked} untracked, ${deleted} deleted → ${label} · ` +
			(match ? "tree matches" : `TREE MISMATCH (local ${s.tree.slice(0, 12)}, VM ${String(applied.tree).slice(0, 12)})`) +
			(lockfileChanged ? " · lockfile changed" : "");
		return {
			text,
			isError: !match,
			structured: {
				vm, host: host.name, from: s.root, to: dest, sha: s.head, snapshot: s.snap,
				counts: s.counts, tree: { local: s.tree, vm: applied.tree ?? null, match },
				lockfile_changed: lockfileChanged, transferred_bytes: bytes, elapsed_ms: Date.now() - started,
			},
		};
	} finally {
		// A bundle the transfer left but apply never consumed (cancelled or refused before it ran) is removed.
		if (sent) await sshRun(vm, `rm -f ${q(remoteBundle)}`, { timeoutMs: 15_000 }).catch(() => {});
		await rm(scratch, { recursive: true, force: true });
	}
}

export const SYNC_OUTPUT = {
	type: "object",
	properties: {
		vm: { type: "string" }, host: { type: "string" },
		from: { type: "string", description: "the local repository root" },
		to: { type: "string", description: "the VM checkout" },
		sha: { type: "string", description: "local HEAD, checked out (detached) in the VM" },
		snapshot: { type: "string", description: "commit of HEAD plus the working changes (= sha when there are none); the VM's refs/boxery/synced" },
		counts: { type: "object", properties: { modified: { type: "integer" }, untracked: { type: "integer" }, deleted: { type: "integer" } } },
		tree: { type: "object", description: "git tree of the whole working directory (tracked + untracked, not ignored), computed on each side", properties: { local: { type: "string" }, vm: { type: ["string", "null"] }, match: { type: "boolean" } } },
		lockfile_changed: { type: "boolean", description: `a lockfile (${LOCKFILES.join(", ")}) differs from the previous sync: dependencies need installing` },
		transferred_bytes: { type: "integer", description: "bytes of bundle sent (0: the VM had every commit)" },
		elapsed_ms: { type: "integer" },
	},
};
