// Real CLI, isolated registry and host stubs. No SSH or real host state.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";
import { isListing } from "../controller/all-hosts.mjs";

const root = mkdtempSync(path.join(tmpdir(), "boxery-all-hosts-"));
const home = path.join(root, "registry"), calls = path.join(root, "calls"), hostbin = path.join(root, "host");
const profile = (/** @type {string} */ name) => path.join(root, name);
writeFileSync(hostbin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2), name = process.env.STUB_NAME;
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({name, args}) + '\\n');
if (process.env.FAIL_HOST === name) { console.error('unreachable fixture host'); process.exit(255); }
if (args[0] === 'help') { console.log('known-hosts NAME'); process.exit(); }
if (args[0] === 'version') console.log(JSON.stringify({version:'0.1.0',describe:null,install:'npm'}));
else if (args.includes('--json')) console.log(JSON.stringify({name, args}));
else if (args[0] === 'upgrade' && args.includes('--check')) console.error('==> fetching origin\\n==> up to date at v0.12.0\\n==> profiles: ' + name);
else if (args[0] === 'images') console.log('IMAGE                                    CREATED               SIZE        AGE    GUEST\\n' + name + '@s1                                  2026-01-01            1GiB        1d     current');
else { console.log(name + ': ' + args.join(' ')); console.error('==> fixture note'); }
`);
chmodSync(hostbin, 0o755);
for (const name of ["alpha", "beta", "gamma"]) {
	registerHost(home, name, profile(name));
	writeFileSync(path.join(profile(name), "config"), `HOST=local\nHOST_BIN='${hostbin}'\nexport STUB_NAME=${name}\n`);
	writeFileSync(path.join(profile(name), "backend"), "fake\n");
}
// Same-directory alias must not cause a second call or a second section.
registerHost(home, "beta-alias", profile("beta"));
const env = { ...process.env, HOME: path.join(root, "home"), BOXERY_HOME: home, NO_COLOR: "1" };
/** @param {string[]} args @param {NodeJS.ProcessEnv} [extra] */
function run(args, extra = {}) {
	return spawnSync(path.resolve(import.meta.dirname, "../controller/boxery"), args, { env: { ...env, ...extra }, encoding: "utf8", input: "", timeout: 20_000 });
}
const hostCalls = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args[0] !== "help");
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => { writeFileSync(calls, ""); writeFileSync(path.join(home, "default-host"), "beta\n"); });

const LISTINGS = [["lease", "ls"], ["leases"], ["pool", "ls"], ["version"], ["shapes"], ["host", "capabilities"], ["capabilities"], ["host", "backends"], ["backends"], ["host", "upgrade", "--check"], ["upgrade-host", "--check"], ["runners", "status"], ["runners"]];
test("read-only text listings share ls headings, default-first order and alias deduplication", () => {
	for (const args of LISTINGS) {
		writeFileSync(calls, "");
		const r = run(args);
		assert.equal(r.status, 0, `${args}: ${r.stderr}`);
		assert.match(r.stdout, /beta \(default; also beta-alias\): fake on this machine/);
		assert.match(r.stdout, /alpha: fake on this machine/);
		assert.match(r.stdout, /gamma: fake on this machine/);
		assert.ok(r.stdout.indexOf("beta (") < r.stdout.indexOf("alpha:"));
		if (args[0] !== "lease" && args[0] !== "leases") {
			assert.deepEqual(hostCalls().map((c) => c.name).sort(), ["alpha", "beta", "gamma"]);
		}
		if (args[0] === "version") {
			assert.match(r.stdout, /^controller  /);
			assert.equal((r.stdout.match(/host        0.1.0/g) ?? []).length, 3);
			assert.equal((r.stderr.match(/is older than this controller/g) ?? []).length, 3);
		}
	}
});

test("upgrade checks group stderr-only reports under each host without prefixes", () => {
	for (const args of [["upgrade-host", "--check"], ["host", "upgrade", "--check"]]) {
		const r = run(args);
		assert.equal(r.status, 0, r.stderr);
		assert.doesNotMatch(r.stderr, /==>|fetching origin|up to date|profiles:/);
		assert.equal(r.stdout, [
			"beta (default; also beta-alias): fake on this machine",
			"alpha: fake on this machine",
			"gamma: fake on this machine",
		].map((heading, i) => `${heading}\n==> fetching origin\n==> up to date at v0.12.0\n==> profiles: ${["beta", "alpha", "gamma"][i]}`).join("\n\n") + "\n");
	}
});

test("snapshot images and images have one HOST table header, not host sections", () => {
	for (const args of [["snapshot", "images"], ["images"]]) {
		const r = run(args);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^HOST\s+IMAGE\s+CREATED/);
		assert.equal((r.stdout.match(/IMAGE/g) ?? []).length, 1);
		for (const name of ["alpha", "beta", "gamma"]) assert.match(r.stdout, new RegExp(`^${name}\\s+${name}@s1`, "m"));
		assert.doesNotMatch(r.stdout, /default|also beta-alias/);
	}
});

test("unreachable hosts do not hide other hosts, and produce one final failure", () => {
	for (const args of [...LISTINGS.filter((a) => !["lease", "leases"].includes(a[0])), ["snapshot", "images"]]) {
		const r = run(args, { FAIL_HOST: "beta" });
		assert.equal(r.status, 1, `${args}: ${r.stderr}`);
		assert.match(r.stdout, /alpha/);
		assert.match(r.stdout, /gamma/);
		assert.match(r.stdout, /failed: see below/);
		if (args[0] === "snapshot") assert.match(r.stdout, /^HOST\s+IMAGE/);
		assert.equal((r.stderr.match(/unreachable fixture host/g) ?? []).length, 1);
		assert.match(r.stderr, /boxery: beta:/);
	}
});

test("--host preserves single-host output; JSON always selects one host", () => {
	for (const args of [...LISTINGS, ["snapshot", "images"]]) {
		writeFileSync(calls, "");
		const r = run(["--host", "alpha", ...args]);
		assert.equal(r.status, 0, `${args}: ${r.stderr}`);
		assert.doesNotMatch(r.stdout, /default|on this machine|HOST\s+IMAGE/);
		assert.ok(hostCalls().every((c) => c.name === "alpha"));
		if (args.includes("--check") || (args[0] === "runners" && args.length === 1)) continue;
		writeFileSync(calls, "");
		const json = run([...args, "--json"]);
		assert.equal(json.status, 0, `${args}: ${json.stderr}`);
		JSON.parse(json.stdout);
		assert.ok(hostCalls().every((c) => c.name === "beta"));
	}
});

test("one registered host keeps the original output without headings or HOST column", () => {
	const registry = path.join(home, "host-registry");
	const saved = ["alpha", "gamma", "beta-alias"].map((name) => [name, readFileSync(path.join(registry, name), "utf8")]);
	try {
		for (const [name] of saved) rmSync(path.join(registry, name));
		for (const args of [...LISTINGS, ["images"]]) {
			const r = run(args);
			assert.equal(r.status, 0, r.stderr);
			assert.doesNotMatch(r.stdout, /default|on this machine|HOST\s+IMAGE/);
		}
	} finally { for (const [name, value] of saved) writeFileSync(path.join(registry, name), value); }
});

test("leases remain profile-local and are listed without contacting any host", () => {
	for (const name of ["alpha", "gamma"]) {
		const dir = path.join(profile(name), "leases"); mkdirSync(dir, { recursive: true });
		const id = `l-${(name === "alpha" ? "a" : "c").repeat(32)}`;
		writeFileSync(path.join(dir, `${id}.lease`), `name=pool-${name}\nid=${id}\nexpires=9999999999\n`);
	}
	const r = run(["lease", "ls"], { FAIL_HOST: "alpha" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /pool-alpha/);
	assert.match(r.stdout, /pool-gamma/);
	assert.equal(hostCalls().length, 0);
});

test("mutations and VM-name commands never opt into the listing path", () => {
	for (const [command, args] of /** @type {[string, string[]][]} */ ([["upgrade-host", []], ["upgrade-host", ["--ref", "master"]], ["upgrade-host", ["--ref", "--check"]], ["upgrade-host", ["--wait", "--check"]], ["pool", ["add", "demo"]], ["pool", ["rm", "demo"]], ["runners", ["start"]], ["runners", ["stop"]], ["runners", ["once"]], ["snaps", ["demo"]], ["renew", ["demo"]], ["capabilities", ["--json"]]])) assert.equal(isListing(command, args), false);
	assert.equal(isListing("upgrade-host", ["--ref", "master", "--check"]), true);
	for (const args of [["host", "upgrade"], ["pool", "add", "demo"], ["pool", "rm", "demo"], ["runners", "start"]]) {
		writeFileSync(calls, "");
		const r = run(args);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(hostCalls().length > 0);
		assert.ok(hostCalls().every((c) => c.name === "beta"));
	}
});
