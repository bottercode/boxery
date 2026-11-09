// Copyable controller hints; no real HOME, profile, credential, SSH destination or VM.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { hostTransport } from "./fixtures/host-transport.mjs";
import { registerHost } from "./fixtures/register-host.mjs";
import { commandRef, shellWord } from "../help/index.mjs";

const root = mkdtempSync(path.join(tmpdir(), "boxery-hints-"));
const home = path.join(root, "registry"), bin = path.join(root, "bin");
const profile = (/** @type {string} */ name) => path.join(root, name);
process.env.BOXERY_HOME = home;
const { COMMANDS } = await import("../controller/cli.mjs");
const { CLI } = await import("../controller/usage.mjs");
const { hint, invokedAs } = await import("../controller/lib.mjs");
const cli = path.resolve(import.meta.dirname, "../controller/boxery");
const id = "job-20261109-000001-abcdef";
mkdirSync(bin);
for (const name of ["alpha", "beta"]) registerHost(home, name, profile(name));
hostTransport(root, [profile("alpha"), profile("beta")]);
writeFileSync(path.join(home, "default-host"), "alpha\n");
writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env node
console.log(${JSON.stringify(id)});
`);
writeFileSync(path.join(bin, "boxery"), "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n");
for (const file of ["ssh", "boxery"]) chmodSync(path.join(bin, file), 0o755);
const env = { ...process.env, HOME: path.join(root, "home"), BOXERY_HOME: home, PATH: `${bin}:${process.env.PATH}`, SSH_AUTH_SOCK: "", BOXERY_STATUS: "0", NO_COLOR: "1" };
/** @param {string[]} args */
const run = (args) => {
	const options = { env, encoding: /** @type {const} */ ("utf8"), input: "", timeout: 10_000, cwd: root, detached: true };
	return spawnSync(cli, args, options);
};
after(() => { invokedAs(""); rmSync(root, { recursive: true, force: true }); });

/** A hint through a shell with a capture-only boxery executable, never a real host command. @param {string} line */
const words = (line) => JSON.parse(execFileSync("/bin/sh", ["-c", line], { env, cwd: root, encoding: "utf8", timeout: 10_000 }));

test("shell words round-trip empty strings, quotes, Unicode and metacharacters without execution", () => {
	const values = ["", "a b", "it's", "$HOME", "$(touch SHOULD_NOT_EXIST)", "; touch SHOULD_NOT_EXIST", "line1\nline2", "@", "--help", "é"];
	const out = execFileSync("/bin/sh", ["-c", `printf '%s\\0' ${values.map(shellWord).join(" ")}`], { env, cwd: root, timeout: 10_000 });
	assert.deepEqual(out.toString().split("\0").slice(0, -1), values);
	assert.equal(existsSync(path.join(root, "SHOULD_NOT_EXIST")), false);
});

test("references validate command paths, prefer canonical spellings, and quote every dynamic word", () => {
	const args = ["demo", id, "-f", "", "a b", "'quoted'", "$HOME; false"];
	const line = commandRef(CLI, COMMANDS, "job logs", args, ["--host", "beta"]);
	assert.deepEqual(words(line), ["--host", "beta", "job", "logs", ...args]);
	assert.equal(commandRef(CLI, COMMANDS, "list"), "boxery ls");
	for (const ref of ["", "missing", "constructor", "job nope", "host __proto__", "job logs extra", "job  logs", "run --bg"]) assert.throws(() => commandRef(CLI, COMMANDS, ref), /unknown command reference/);
	for (const ref of ["jobs", "grants", "agent-forward"]) assert.throws(() => commandRef(CLI, COMMANDS, ref), /canonical family action/);
});

test("hint context is read at call time and supports a specific host without mutating the context", () => {
	invokedAs("alpha");
	assert.equal(hint("job wait", ["demo", id]), `boxery --host alpha job wait demo ${id}`);
	assert.equal(hint("lease renew", ["pool1"], { host: "beta" }), "boxery --host beta lease renew pool1");
	assert.equal(hint("version"), "boxery --host alpha version");
	invokedAs("");
	assert.equal(hint("version"), "boxery version");
});

test("background-job hints use canonical actions and retain an explicit host, not the default", () => {
	for (const prefix of [[], ["--host", "beta"]]) {
		const r = run([...prefix, "run", "--bg", "demo", "true"]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, `${id}\n`);
		const expected = ["boxery", ...prefix].join(" ");
		assert.match(r.stderr, new RegExp(`logs: ${expected} job logs demo ${id} -f`));
		assert.match(r.stderr, new RegExp(`wait: ${expected} job wait demo ${id}`));
	}
	assert.equal(readFileSync(path.join(home, "default-host"), "utf8"), "alpha\n");
});

test("headless grant guidance is canonical, host-pinned and safely copyable; approval still refuses", () => {
	const command = "printf '%s' 'a b;$HOME'";
	for (const prefix of [[], ["--host", "beta"]]) {
		const r = run([...prefix, "access", "grant", "demo", "env:API_TOKEN", "--cmd", command]);
		assert.equal(r.status, 1, r.stderr);
		assert.match(r.stderr, /grants need a person/);
		const line = r.stderr.split("\n").find((l) => l.startsWith("boxery --host "));
		assert.ok(line, r.stderr);
		assert.deepEqual(words(line), ["--host", prefix.length ? "beta" : "alpha", "access", "grant", "demo", "env:API_TOKEN", "--cmd", command]);
		assert.equal(existsSync(path.join(profile(prefix.length ? "beta" : "alpha"), "grants/demo")), false);
	}
});
