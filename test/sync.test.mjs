// vm_sync with real git and tar against temporary fake SSH endpoints (test/fixtures/copy-ssh.mjs): each
// "VM" is a directory, and its ssh runs scripts there with /home/agent mapped to it. No real VMs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test as nodeTest } from "node:test";
import { q } from "../core/shell.mjs";
import { deniedSyncPath } from "../core/sync.mjs";
const test = (/** @type {string} */ name, /** @type {() => Promise<void> | void} */ fn) => nodeTest(name, { timeout: 60_000 }, fn);

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
/** @type {string} */ let dir;
/** @type {NodeJS.ProcessEnv} */ let env;
/** @type {string} */ let repo;
const vmProject = () => path.join(dir, "vms", "alpha", "vm", "project");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const write = (/** @type {string} */ root, /** @type {string} */ rel, /** @type {string | Buffer} */ data) => {
	mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	writeFileSync(path.join(root, rel), data);
};
const read = (/** @type {string} */ root, /** @type {string} */ rel) => readFileSync(path.join(root, rel), "utf8");

/** Run vm_sync in a worker; abortWhen(dir) → abort once it returns true. @param {object} [params] @param {{ abortWhen?: () => boolean, vm?: string }} [opts] */
function sync(params = {}, { abortWhen, vm = "vm" } = {}) {
	const child = spawn(process.execPath, [path.join(FIXTURES, "sync-worker.mjs"), vm, JSON.stringify({ from: repo, ...params })], {
		env, cwd: dir, stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let out = "", err = "";
	child.stdout?.on("data", (d) => { out += d; });
	child.stderr?.on("data", (d) => { err += d; });
	let timer;
	if (abortWhen) timer = setInterval(() => { if (abortWhen() && child.connected) { child.send("abort"); clearInterval(timer); } }, 5);
	return new Promise((resolve, reject) => {
		child.on("close", () => {
			clearInterval(timer);
			try { resolve(JSON.parse(out)); } catch { reject(new Error(`sync worker produced no result: ${err} ${out}`)); }
		});
	});
}
async function ok(params, opts) {
	const r = /** @type {any} */ (await sync(params, opts));
	assert.equal(r.ok, true, r.error);
	return r;
}
/** Every tracked and untracked (not ignored) file with its content, relative to root. @param {string} root */
function tree(root) {
	const files = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean)
		.filter((f) => existsSync(path.join(root, f)));
	return Object.fromEntries([...new Set(files)].sort().map((f) => [f, readFileSync(path.join(root, f)).toString("base64")]));
}

beforeEach(() => {
	// Match the canonical --copy-root used by servers (macOS's temp directory is under /var → /private/var).
	dir = realpathSync(mkdtempSync(path.join(tmpdir(), "boxery-sync-")));
	mkdirSync(path.join(dir, "bin"));
	const home = path.join(dir, "home");
	mkdirSync(path.join(home, "host-registry"), { recursive: true });
	const profile = path.join(home, "profiles", "alpha");
	mkdirSync(profile, { recursive: true });
	writeFileSync(path.join(profile, "config"), "# fake\n");
	writeFileSync(path.join(profile, "ssh_config"), "# fake\n");
	writeFileSync(path.join(home, "host-registry", "alpha"), `${profile}\n`);
	writeFileSync(path.join(home, "default-host"), "alpha\n");
	for (const vm of ["vm", "other"]) mkdirSync(path.join(dir, "vms", "alpha", vm, "tmp"), { recursive: true });
	writeFileSync(path.join(dir, "calls"), "");
	writeFileSync(path.join(dir, "bin", "ssh"), `#!/usr/bin/env bash\nexec ${q(process.execPath)} ${q(path.join(FIXTURES, "copy-ssh.mjs"))} "$@"\n`, { mode: 0o755 });
	writeFileSync(path.join(dir, "bin", "tar"), `#!/usr/bin/env bash\nexec ${q(process.execPath)} ${q(path.join(FIXTURES, "copy-tar.mjs"))} "$@"\n`, { mode: 0o755 });
	// sync deliberately strips caller GIT_* overrides; isolate system config at the executable boundary.
	writeFileSync(path.join(dir, "bin", "git"), `#!/usr/bin/env bash\nexport GIT_CONFIG_NOSYSTEM=1\nexec ${q(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim())} "$@"\n`, { mode: 0o755 });
	writeFileSync(path.join(dir, "bin", "setsid"), "#!/usr/bin/env bash\n[ \"$1\" != -w ] || shift\nexec perl -e 'setpgrp(0,0); exec @ARGV or die' -- \"$@\"\n", { mode: 0o755 });
	env = {
		...process.env, ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, BOXERY_HOME: home,
		COPY_ROOT: dir, COPY_LOG: path.join(dir, "calls"), REAL_TAR: execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim(),
		REAL_GIT: execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
	};
	repo = path.join(dir, "local", "repo");
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	write(repo, ".gitignore", "node_modules/\ndist/\n");
	write(repo, "README.md", "hello\n");
	write(repo, "src/app.js", "console.log(1);\n");
	write(repo, "src/old name.txt", "rename me\n");
	write(repo, "gone.txt", "delete me\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "first");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("first sync into an empty directory: a detached checkout that matches", async () => {
	const r = await ok();
	const head = git(repo, "rev-parse", "HEAD");
	assert.match(r.text, new RegExp(`^synced ${head.slice(0, 7)} \\+ 0 modified, 0 untracked, 0 deleted → vm:/home/agent/project · tree matches$`));
	assert.equal(r.structured.sha, head);
	assert.equal(r.structured.tree.match, true);
	assert.equal(r.structured.tree.local, r.structured.tree.vm);
	assert.equal(r.structured.pushed, true);
	assert.ok(r.structured.objects_sent > 0);
	assert.ok(readFileSync(path.join(dir, "calls"), "utf8").includes("receive-pack"), "commits went by git push");
	assert.equal(git(vmProject(), "for-each-ref", "refs/boxery/incoming/"), "", "the pushed ref is dropped after apply");
	assert.equal(typeof r.structured.elapsed_ms, "number");
	assert.equal(git(vmProject(), "rev-parse", "HEAD"), head);
	assert.throws(() => git(vmProject(), "symbolic-ref", "-q", "HEAD"), "detached");
	assert.deepEqual(tree(vmProject()), tree(repo));
	assert.equal(git(vmProject(), "status", "--porcelain"), "", "a clean checkout in the VM");
	assert.equal(git(vmProject(), "remote"), "", "no remote configured");
});

test("new commits, dirty, untracked, deleted and renamed files, a binary and spaces in names", async () => {
	await ok();
	write(repo, "src/app.js", "console.log(2);\n");
	git(repo, "commit", "-qam", "second");
	write(repo, "README.md", "hello, changed\n"); // unstaged
	write(repo, "staged.txt", "staged\n");
	git(repo, "add", "staged.txt"); // staged, new
	write(repo, "notes with spaces.md", "untracked\n");
	write(repo, "bin/blob.bin", Buffer.from([0, 255, 1, 254, 0, 10, 13, 0]));
	unlinkSync(path.join(repo, "gone.txt"));
	renameSync(path.join(repo, "src/old name.txt"), path.join(repo, "src/new name.txt"));
	const r = await ok();
	assert.equal(r.structured.sha, git(repo, "rev-parse", "HEAD"));
	assert.equal(git(vmProject(), "rev-parse", "HEAD"), r.structured.sha);
	assert.equal(r.structured.tree.match, true);
	assert.deepEqual(r.structured.counts, { modified: 3, untracked: 2, deleted: 1 }, "README, staged.txt, the rename; two untracked; gone.txt");
	assert.deepEqual(tree(vmProject()), tree(repo));
	assert.deepEqual(readFileSync(path.join(vmProject(), "bin/blob.bin")), Buffer.from([0, 255, 1, 254, 0, 10, 13, 0]));
	assert.ok(!existsSync(path.join(vmProject(), "gone.txt")));
	assert.ok(!existsSync(path.join(vmProject(), "src/old name.txt")));
	// The VM shows the same working changes against HEAD as the local checkout.
	assert.match(git(vmProject(), "status", "--porcelain"), /notes with spaces/);
	assert.equal(git(repo, "status", "--porcelain").length > 0, true, "the local checkout is untouched");
	assert.equal(git(repo, "for-each-ref").includes("boxery"), false, "no refs written locally");

	// Reverting local changes removes the earlier sync's leftovers.
	git(repo, "checkout", "-q", "--", ".");
	git(repo, "reset", "-q", "--hard");
	git(repo, "clean", "-qfd");
	const r2 = await ok();
	assert.deepEqual(r2.structured.counts, { modified: 0, untracked: 0, deleted: 0 });
	assert.deepEqual(tree(vmProject()), tree(repo));
	assert.ok(!existsSync(path.join(vmProject(), "notes with spaces.md")));
});

test("ignored files in the VM survive a sync", async () => {
	await ok();
	write(vmProject(), "node_modules/dep/index.js", "module.exports = 1;\n");
	write(vmProject(), "dist/out.js", "built\n");
	write(repo, "src/app.js", "console.log(3);\n");
	const r = await ok();
	assert.equal(r.structured.tree.match, true);
	assert.equal(read(vmProject(), "node_modules/dep/index.js"), "module.exports = 1;\n");
	assert.equal(read(vmProject(), "dist/out.js"), "built\n");
	assert.equal(read(vmProject(), "src/app.js"), "console.log(3);\n");
});

test("a VM-side edit blocks the sync and changes nothing", async () => {
	await ok();
	write(vmProject(), "src/app.js", "edited in the VM\n");
	write(vmProject(), "scratch.txt", "new in the VM\n");
	write(repo, "README.md", "local change\n");
	const before = tree(vmProject());
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /refused: vm:\/home\/agent\/project has changes since the last sync that vm_sync didn't make/);
	assert.match(r.error, /M src\/app\.js/);
	assert.match(r.error, /A scratch\.txt/);
	assert.deepEqual(tree(vmProject()), before);
	assert.equal(read(vmProject(), "README.md"), "hello\n");
});

test("a dirty VM checkout that was never synced blocks the sync", async () => {
	mkdirSync(vmProject(), { recursive: true });
	git(vmProject(), "init", "-q");
	write(vmProject(), "mine.txt", "x\n");
	git(vmProject(), "add", "-A");
	git(vmProject(), "commit", "-qm", "vm");
	write(vmProject(), "mine.txt", "dirty\n");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /changes against its HEAD/);
	assert.equal(read(vmProject(), "mine.txt"), "dirty\n");
});

test("a non-empty directory that isn't a repository is refused", async () => {
	write(vmProject(), "stray.txt", "x\n");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /is not a git repository and is not empty \(stray\.txt/);
	assert.ok(!existsSync(path.join(vmProject(), ".git")));
});

test("deny-listed files block the sync, naming the path and vm_grant", async () => {
	await ok();
	write(repo, "config/.env.local", "SECRET=1\n");
	write(repo, "README.md", "changed\n");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /config\/\.env\.local/);
	assert.match(r.error, /vm_grant/);
	assert.equal(read(vmProject(), "README.md"), "hello\n", "nothing changed in the VM");
	// Once ignored, the rest syncs.
	write(repo, ".gitignore", "node_modules/\ndist/\n.env*\n");
	assert.equal((await ok()).structured.tree.match, true);
	assert.ok(!existsSync(path.join(vmProject(), "config/.env.local")));
});

test("the deny list", () => {
	for (const p of [".env", ".env.local", "a/.env.production", ".envrc", ".npmrc", "x/.pypirc", ".netrc", ".git-credentials", "auth.json", ".docker/config.json", "home/.kube/config", "credentials", "id_ed25519"])
		assert.ok(deniedSyncPath(p), p);
	for (const p of [".ENV", ".env-prod", ".env_local", "ID_RSA", "id_rsa_work", "Credentials.json", ".yarnrc.yml", "certs/server.pem", "tls.key", "store.p12", ".terraformrc"])
		assert.ok(deniedSyncPath(p), p);
	for (const p of [".env.example", ".env.sample", ".env-template", "environment.ts", "src/auth.js", "npmrc.md", "docs/credentials.md", "id_ed25519.pub", "ID_RSA.PUB", "keys.ts"])
		assert.ok(!deniedSyncPath(p), p);
});

test("a second sync with no local changes transfers nothing and still matches", async () => {
	write(repo, "wip.txt", "uncommitted\n");
	const first = await ok();
	const calls = readFileSync(path.join(dir, "calls"), "utf8").split("\n").filter(Boolean).length;
	const second = await ok();
	assert.equal(second.structured.pushed, false);
	assert.equal(second.structured.objects_sent, 0);
	assert.equal(second.structured.tree.match, true);
	assert.equal(second.structured.lockfile_changed, false);
	assert.equal(second.structured.snapshot, first.structured.snapshot, "the same working changes give the same snapshot commit");
	assert.match(second.text, /· tree matches$/);
	const pushes = readFileSync(path.join(dir, "calls"), "utf8").split("\n").filter(Boolean).slice(calls).map((l) => JSON.parse(l)).filter((c) => String(c.script).includes("receive-pack"));
	assert.deepEqual(pushes, [], "no push the second time");
});

test("a lockfile change is flagged, once", async () => {
	write(repo, "package-lock.json", "{\"v\":1}\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "lock");
	assert.equal((await ok()).structured.lockfile_changed, true, "new on the first sync");
	assert.equal((await ok()).structured.lockfile_changed, false);
	write(repo, "packages/web/pnpm-lock.yaml", "lockfileVersion: 9\n"); // untracked, nested
	const r = await ok();
	assert.equal(r.structured.lockfile_changed, true);
	assert.match(r.text, /lockfile changed/);
	write(repo, "README.md", "unrelated\n");
	assert.equal((await ok()).structured.lockfile_changed, false);
});

test("cancellation mid-push leaves the VM unchanged", async () => {
	await ok();
	const before = tree(vmProject());
	const head = git(vmProject(), "rev-parse", "HEAD");
	const refs = git(vmProject(), "for-each-ref");
	write(repo, "big.bin", randomBytes(4 * 1024 * 1024));
	write(repo, "README.md", "changed\n");
	const started = path.join(dir, "receive-started");
	// Only here: a git double whose receive-pack (the VM end of the push) is slow.
	writeFileSync(path.join(dir, "bin", "git"), `#!/usr/bin/env bash\nexec ${q(process.execPath)} ${q(path.join(FIXTURES, "sync-git.mjs"))} "$@"\n`, { mode: 0o755 });
	env.SYNC_SLOW_RECEIVE = started;
	env.FAKE_VM_PATH = env.PATH;
	const r = /** @type {any} */ (await sync({}, { abortWhen: () => existsSync(started) }));
	delete env.SYNC_SLOW_RECEIVE;
	delete env.FAKE_VM_PATH;
	unlinkSync(path.join(dir, "bin", "git"));
	assert.ok(existsSync(started), `the push was in flight (${r.error ?? "it finished"})`);
	assert.equal(r.ok, false);
	assert.equal(r.name, "AbortError");
	assert.deepEqual(tree(vmProject()), before);
	assert.equal(git(vmProject(), "rev-parse", "HEAD"), head);
	assert.equal(git(vmProject(), "for-each-ref"), refs, "no ref was written");
	// receive-pack quarantines incoming objects and removes them when the push dies.
	const objects = path.join(vmProject(), ".git", "objects");
	for (let i = 0; i < 100 && readdirSync(objects).some((n) => n.startsWith("tmp_objdir")); i++) await new Promise((res) => setTimeout(res, 50));
	assert.deepEqual(readdirSync(objects).filter((n) => n.startsWith("tmp_objdir")), [], "no quarantined objects left");
	assert.equal((await ok()).structured.tree.match, true, "a later sync completes");
});

test("a push into a missing directory creates the repository only there", async () => {
	const r = await ok({ to: "~/fresh/repo" });
	assert.equal(r.structured.tree.match, true);
	const vmHome = path.join(dir, "vms", "alpha", "vm");
	assert.deepEqual(tree(path.join(vmHome, "fresh", "repo")), tree(repo));
});

test("an interrupted swap is undone by the next sync", async () => {
	await ok();
	write(repo, "README.md", "next\n");
	// Simulate a crash mid-swap: the pending record is there, the working directory half updated.
	const g = path.join(vmProject(), ".git");
	const synced = git(vmProject(), "rev-parse", "refs/boxery/synced^{tree}");
	write(vmProject(), "README.md", "half written\n");
	const half = git(vmProject(), "rev-parse", `${git(vmProject(), "stash", "create")}^{tree}`);
	writeFileSync(path.join(g, "boxery-sync-pending"), `${synced} ${half}\n`);
	writeFileSync(path.join(g, "boxery-sync-index.bak"), readFileSync(path.join(g, "index")));
	const r = await ok();
	assert.equal(r.structured.tree.match, true);
	assert.equal(read(vmProject(), "README.md"), "next\n");
	assert.ok(!existsSync(path.join(g, "boxery-sync-pending")));
});

test("a local path that isn't a git checkout gives a clear error", async () => {
	const plain = path.join(dir, "plain");
	mkdirSync(plain);
	const r = /** @type {any} */ (await sync({ from: plain }));
	assert.equal(r.ok, false);
	assert.match(r.error, /is not a git checkout .*use vm_copy for other files/);
	assert.ok(!existsSync(vmProject()), "the VM was not touched");
});

test("a subdirectory syncs its whole repository; to picks the VM directory", async () => {
	const r = await ok({ from: path.join(repo, "src"), to: "elsewhere/repo" });
	assert.equal(r.structured.from, repo);
	assert.equal(r.structured.to, "/home/agent/project/elsewhere/repo");
	assert.deepEqual(tree(path.join(vmProject(), "elsewhere/repo")), tree(repo));
});

test("local: refused or confined like vm_copy", async () => {
	const refused = /** @type {any} */ (await sync({ local: false }));
	assert.equal(refused.ok, false);
	assert.match(refused.error, /vm_sync is disabled on this server/);
	const outside = /** @type {any} */ (await sync({ local: { root: path.join(dir, "vms") } }));
	assert.equal(outside.ok, false);
	assert.match(outside.error, /outside the copy root/);
	const inside = await ok({ from: "repo", local: { root: path.join(dir, "local") } });
	assert.equal(inside.structured.tree.match, true);
});

test("a credential in history the VM lacks blocks the sync, even when it's gone from the tree", async () => {
	write(repo, ".env", "SECRET=1\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "oops");
	git(repo, "rm", "-q", ".env");
	git(repo, "commit", "-qm", "remove it");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /\.env is in the history this sync would send/);
	assert.ok(!existsSync(vmProject()), "nothing sent");
});

test("a VM edit made after an interrupted swap isn't lost", async () => {
	await ok();
	write(repo, "README.md", "next\n");
	const g = path.join(vmProject(), ".git");
	const synced = git(vmProject(), "rev-parse", "refs/boxery/synced^{tree}");
	write(vmProject(), "README.md", "half written\n");
	const half = git(vmProject(), "rev-parse", `${git(vmProject(), "stash", "create")}^{tree}`);
	writeFileSync(path.join(g, "boxery-sync-pending"), `${synced} ${half}\n`);
	write(vmProject(), "src/app.js", "edited in the VM after the crash\n");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /interrupted earlier sync .* src\/app\.js/s);
	assert.equal(read(vmProject(), "src/app.js"), "edited in the VM after the crash\n");
	assert.ok(existsSync(path.join(g, "boxery-sync-pending")), "the record stays for the next attempt");
});

test("an interrupted swap whose refs were written is finished, not undone", async () => {
	await ok();
	const g = path.join(vmProject(), ".git");
	const synced = git(vmProject(), "rev-parse", "refs/boxery/synced^{tree}");
	writeFileSync(path.join(g, "boxery-sync-pending"), `${"0".repeat(40)} ${synced}\n`);
	const r = await ok();
	assert.equal(r.structured.tree.match, true);
	assert.ok(!existsSync(path.join(g, "boxery-sync-pending")));
});

test("a path the VM has as an ignored file that local now tracks is refused, not overwritten", async () => {
	await ok();
	const synced = git(vmProject(), "rev-parse", "refs/boxery/synced");
	write(vmProject(), "dist/out.js", "the VM's own build\n");
	write(repo, "dist/out.js", "force-added locally\n");
	git(repo, "add", "-f", "dist/out.js");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /tracks paths that exist in the VM as ignored files .*dist\/out\.js/s);
	assert.equal(read(vmProject(), "dist/out.js"), "the VM's own build\n");
	assert.equal(git(vmProject(), "rev-parse", "refs/boxery/synced"), synced, "nothing recorded");
	assert.throws(() => git(vmProject(), "rev-parse", "-q", "--verify", "refs/boxery/incoming"), "fetched ref dropped");
});

test("an ignored VM directory replaced by a tracked file is refused", async () => {
	await ok();
	write(vmProject(), "dist/keep.js", "built\n");
	write(repo, ".gitignore", "node_modules/\n");
	write(repo, "dist", "now a file\n");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /dist/);
	assert.equal(read(vmProject(), "dist/keep.js"), "built\n");
});

test("un-ignoring a path with VM files refuses cleanly, and the next sync isn't stuck", async () => {
	await ok();
	write(vmProject(), "dist/out.js", "built\n");
	write(repo, ".gitignore", "node_modules/\n");
	const before = git(vmProject(), "rev-parse", "refs/boxery/synced");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /ignored no longer are: .*dist\/out\.js/s);
	assert.equal(git(vmProject(), "rev-parse", "refs/boxery/synced"), before, "nothing recorded");
	assert.equal(read(vmProject(), ".gitignore"), "node_modules/\ndist/\n", "rolled back");
	rmSync(path.join(vmProject(), "dist"), { recursive: true });
	assert.equal((await ok()).structured.tree.match, true);
});

test("a VM directory inside another checkout is refused", async () => {
	await ok();
	const r = /** @type {any} */ (await sync({ to: "api" }));
	assert.equal(r.ok, false);
	assert.match(r.error, /is inside the git checkout \S*project/);
	assert.ok(!existsSync(path.join(vmProject(), "api")));
});

test("a shallow clone gives a clear error", async () => {
	git(repo, "commit", "-q", "--allow-empty", "-m", "second");
	const shallow = path.join(dir, "local", "shallow");
	git(dir, "clone", "-q", "--depth", "1", `file://${repo}`, shallow);
	const r = /** @type {any} */ (await sync({ from: shallow }));
	assert.equal(r.ok, false);
	assert.match(r.error, /shallow clone/);
});

test("confined: no repository outside the root through a gitfile, and none of its config runs", async () => {
	const root = path.join(dir, "share");
	const outside = path.join(dir, "secret-repo");
	mkdirSync(outside);
	git(outside, "init", "-q");
	write(outside, "private.txt", "private\n");
	git(outside, "add", "-A");
	git(outside, "commit", "-qm", "private");
	const marker = path.join(dir, "fsmonitor-ran");
	git(outside, "config", "core.fsmonitor", `touch ${marker}; false`);
	mkdirSync(path.join(root, "checkout"), { recursive: true });
	writeFileSync(path.join(root, "checkout", ".git"), `gitdir: ${path.join(outside, ".git")}\n`);
	const r = /** @type {any} */ (await sync({ from: "checkout", local: { root } }));
	assert.equal(r.ok, false);
	assert.match(r.error, /outside the copy root/);
	assert.ok(!existsSync(marker), "fsmonitor never ran");
	assert.ok(!existsSync(vmProject()));

	// A repository above the root isn't discovered from inside it either.
	git(dir, "init", "-q");
	git(dir, "config", "core.fsmonitor", `touch ${marker}; false`);
	mkdirSync(path.join(root, "plain"));
	const above = /** @type {any} */ (await sync({ from: "plain", local: { root } }));
	assert.equal(above.ok, false);
	assert.match(above.error, /not a git checkout/);
	assert.ok(!existsSync(marker), "fsmonitor never ran");
});

test("confined: a filter driver in the checkout's config is refused", async () => {
	const root = path.join(dir, "local");
	git(repo, "config", "filter.x.clean", "touch /tmp/never");
	const r = /** @type {any} */ (await sync({ from: "repo", local: { root } }));
	assert.equal(r.ok, false);
	assert.match(r.error, /filter driver/);
});

test("an edit in the same second as the index was written, same size, is still seen on both sides", async () => {
	// git trusts an entry's stat data unless the file changed in the same second as the index was written;
	// a copy of the index with a newer mtime would hide such an edit. Pin both to one second to force it.
	const T = new Date("2026-01-01T00:00:00Z");
	const racy = (/** @type {string} */ root, /** @type {string} */ rel, /** @type {string} */ text) => {
		git(root, "update-index", "-q", "--refresh");
		utimesSync(path.join(root, rel), T, T);
		git(root, "update-index", "-q", "--really-refresh");
		utimesSync(path.join(root, ".git", "index"), T, T);
		writeFileSync(path.join(root, rel), text);
		utimesSync(path.join(root, rel), T, T);
	};
	await ok();
	racy(vmProject(), "README.md", "HELLO\n"); // an agent edit in the VM
	const blocked = /** @type {any} */ (await sync());
	assert.equal(blocked.ok, false, "the VM edit was overlooked");
	assert.match(blocked.error, /M README\.md/);
	writeFileSync(path.join(vmProject(), "README.md"), "hello\n");
	racy(repo, "README.md", "jello\n"); // a local edit
	const r = await ok();
	assert.equal(r.structured.counts.modified, 1, "the local edit was overlooked");
	assert.equal(read(vmProject(), "README.md"), "jello\n");
});

test("a credential added and removed in merge commits blocks the sync", async () => {
	git(repo, "checkout", "-q", "-b", "side");
	write(repo, "side.txt", "x\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "side");
	git(repo, "checkout", "-q", "main");
	git(repo, "merge", "-q", "--no-ff", "--no-commit", "side");
	write(repo, ".env", "SECRET=1\n");
	git(repo, "add", "-f", ".env");
	git(repo, "commit", "-qm", "merge with a secret");
	git(repo, "rm", "-q", ".env");
	git(repo, "commit", "-qm", "drop it");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /\.env is in the history this sync would send/);
});

test("the push ignores the user's git config and GIT_* environment, and goes only to the VM", async () => {
	await ok();
	const hostile = path.join(dir, "hostile.gitconfig");
	writeFileSync(hostile, '[url "other.boxery:"]\n\tpushInsteadOf = vm.boxery:\n\tinsteadOf = vm.boxery:\n[push]\n\tpushOption = x\n\tnegotiate = true\n');
	Object.assign(env, { GIT_CONFIG_GLOBAL: hostile, GIT_ALLOW_PROTOCOL: "https", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.other.boxery:.pushInsteadOf", GIT_CONFIG_VALUE_0: "vm.boxery:" });
	write(repo, "README.md", "changed\n");
	const mark = readFileSync(path.join(dir, "calls"), "utf8").length;
	let r;
	try { r = await ok(); } finally {
		for (const k of ["GIT_CONFIG_GLOBAL", "GIT_ALLOW_PROTOCOL", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete env[k];
	}
	assert.equal(r.structured.tree.match, true);
	assert.ok(!existsSync(path.join(dir, "vms", "alpha", "other", "project")), "nothing went to another VM");
	const pushes = readFileSync(path.join(dir, "calls"), "utf8").slice(mark).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => String(c.script).includes("receive-pack"));
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].endpoint, "alpha/vm");
	assert.ok(pushes[0].argv.includes("ControlMaster=no"), "never becomes the shared connection's master");
	assert.ok(pushes[0].argv.includes("BatchMode=yes"));
	assert.match(pushes[0].script, /core\.hooksPath=\/dev\/null .*receive\.autogc=false receive-pack/);
});

test("a push that fails into a new directory leaves no repository behind", async () => {
	writeFileSync(path.join(dir, "bin", "git"), `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" != receive-pack ] || { echo "injected receive-pack failure" >&2; exit 1; }; done\nexec ${q(env.REAL_GIT ?? "git")} "$@"\n`, { mode: 0o755 });
	env.FAKE_VM_PATH = env.PATH;
	let r;
	try { r = /** @type {any} */ (await sync({ to: "~/fresh/repo" })); } finally { unlinkSync(path.join(dir, "bin", "git")); delete env.FAKE_VM_PATH; }
	assert.equal(r.ok, false);
	assert.match(r.error, /git push to VM "vm" failed/);
	assert.ok(!existsSync(path.join(dir, "vms", "alpha", "vm", "fresh", "repo")), "init undone");
});

test("a stale incoming ref from an abandoned sync is dropped; a recent one is kept", async () => {
	await ok();
	const head = git(vmProject(), "rev-parse", "HEAD");
	git(vmProject(), "update-ref", "refs/boxery/incoming/1000-old", head);
	git(vmProject(), "update-ref", `refs/boxery/incoming/${Math.floor(Date.now() / 1000)}-busy`, head);
	write(repo, "README.md", "again\n");
	await ok();
	const refs = git(vmProject(), "for-each-ref", "--format=%(refname)", "refs/boxery/incoming/");
	assert.doesNotMatch(refs, /1000-old/);
	assert.match(refs, /-busy/);
});

test("a partial clone gives a clear error", async () => {
	git(repo, "config", "extensions.partialClone", "origin");
	git(repo, "config", "core.repositoryformatversion", "1");
	const r = /** @type {any} */ (await sync());
	assert.equal(r.ok, false);
	assert.match(r.error, /partial clone/);
});
