// The actual CLI with isolated host profiles and SSH; no real host or credentials.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";
import { hostTransport } from "./fixtures/host-transport.mjs";

const root = mkdtempSync(path.join(tmpdir(), "boxery-ssh-"));
const home = path.join(root, "registry"), bin = path.join(root, "bin");
const profile = (name) => path.join(root, "profiles", name);
const cli = path.resolve(import.meta.dirname, "../controller/boxery");
mkdirSync(bin);
for (const name of ["alpha", "beta"]) {
	registerHost(home, name, profile(name));
	writeFileSync(path.join(profile(name), "ssh_config"), "# fixture\n  KnownHostsCommand /bin/sh -c fixture\n");
}
hostTransport(root, [profile("alpha"), profile("beta")]);
writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.BOXERY_SSH_LOG, 'ssh\\n');
console.log(JSON.stringify({ args: process.argv.slice(2), profile: process.env.BOXERY_STUB_PROFILE }));
process.exit(Number(process.env.BOXERY_SSH_EXIT ?? 0));
`);
chmodSync(path.join(bin, "ssh"), 0o755);
const log = path.join(root, "ssh.calls");
const env = { ...process.env, HOME: path.join(root, "home"), BOXERY_HOME: home, PATH: `${bin}:${process.env.PATH}`, BOXERY_SSH_LOG: log };
const run = (args, extra = {}) => spawnSync(cli, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 10_000, input: "" });
beforeEach(() => {
	writeFileSync(path.join(home, "default-host"), "alpha\n");
	rmSync(log, { force: true });
	rmSync(path.join(root, "host.calls"), { force: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

function connected(args, host, rest = []) {
	const r = run(args);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), { args: ["-F", path.join(profile(host), "ssh_config"), "-t", "demo.boxery", ...rest], profile: profile(host) });
	assert.equal(readFileSync(path.join(home, "default-host"), "utf8"), "alpha\n", "shorthand never changes the default");
}

test("ssh NAME@HOST selects that registered profile, including an interactive shell", () => {
	connected(["ssh", "demo@beta"], "beta");
});

test("ssh NAME and --host NAME keep their existing routing; matching selectors work", () => {
	connected(["ssh", "demo"], "alpha");
	connected(["--host", "beta", "ssh", "demo"], "beta");
	connected(["--host", "beta", "ssh", "demo@beta"], "beta");
});

test("only the target is parsed: command arguments, including @ and --host, stay unchanged", () => {
	const rest = ["printf", "%s\\n", "user@example.org", "--host", "alpha", "a b", "'quoted'", "$HOME; echo done", ""];
	connected(["ssh", "demo@beta", ...rest], "beta", rest);
});

test("shorthand works without a default host", () => {
	rmSync(path.join(home, "default-host"));
	const r = run(["ssh", "demo@beta", "hostname"]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(JSON.parse(r.stdout).profile, profile("beta"));
	assert.equal(existsSync(path.join(home, "default-host")), false);
});

test("conflicting selectors and invalid or unknown targets fail before host/SSH effects", () => {
	/** @type {[string[], RegExp][]} */
	const cases = [
		[["--host", "alpha", "ssh", "demo@beta"], /conflicts with --host alpha/],
		[["ssh", "demo@unknown"], /unknown host: unknown/],
		...["demo@", "@beta", "demo@beta@alpha", "../demo@beta", "demo@../beta", "demo@Beta", "Demo@beta", "demo@-oProxyCommand=x", "demo@beta\n", "demo@beta;touch marker", `${"a".repeat(32)}@beta`, `demo@${"b".repeat(32)}`].map((target) => /** @type {[string[], RegExp]} */ ([["ssh", target], /invalid SSH target/])),
	];
	for (const [args, error] of cases) {
		const r = run(args);
		assert.notEqual(r.status, 0, args.join(" "));
		assert.match(r.stderr, error);
		assert.equal(existsSync(log), false, "no SSH on rejected targets");
		assert.equal(existsSync(path.join(root, "host.calls")), false, "no host calls on rejected targets");
	}
});

test("ssh exit status is preserved with a qualified target", () => {
	const r = run(["ssh", "demo@beta", "false"], { BOXERY_SSH_EXIT: "42" });
	assert.equal(r.status, 42, r.stderr);
});

test("SSH help documents the shorthand without needing a host", () => {
	const r = run(["ssh", "--help"], { BOXERY_HOME: path.join(root, "unconfigured") });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /ssh NAME\[@HOST\]/);
	assert.match(r.stdout, /registered host/);
	assert.equal(existsSync(log), false);
});
