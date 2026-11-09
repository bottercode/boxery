// boxery help: rendered from controller/cli.mjs's command table, and usable before any host is set up.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), "boxery-help-"));
after(() => rmSync(home, { recursive: true, force: true }));
const { COMMANDS } = await import("../controller/cli.mjs");
const { GROUPS } = await import("../controller/usage.mjs");

/** The controller with an empty BOXERY_HOME (no host configured). @param {string[]} args */
function boxery(...args) {
	const r = spawnSync(path.join(ROOT, "controller/boxery"), args, { encoding: "utf8", env: { ...process.env, BOXERY_HOME: home, NO_COLOR: "1" } });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

test("boxery help lists the everyday commands and the families; help --all lists every command", () => {
	const { code, out } = boxery("help");
	assert.equal(code, 0);
	const all = boxery("help", "--all");
	assert.equal(all.code, 0, all.err);
	const rows = (/** @type {string} */ text, /** @type {string} */ name) => new RegExp(`^  ${name.replace(/[-]/g, "\\-")}\\b`, "m").test(text);
	for (const [name, e] of Object.entries(COMMANDS)) {
		if ("alias" in e) continue;
		assert.ok(e.help.group in GROUPS, `${name}: unknown group ${e.help.group}`);
		assert.ok(rows(all.out, name), `${name} is missing from boxery help --all`);
		// older spellings are only in --all; a family and an everyday command are in both
		assert.equal(rows(out, name), e.help.group !== "legacy", `${name}: ${e.help.group === "legacy" ? "an older spelling is in the short help" : "is missing from boxery help"}`);
	}
	for (const family of ["host", "snapshot", "agent", "job", "access", "lease", "pool", "runners"]) assert.match(out, new RegExp(`^  ${family} \\w`, "m"), `${family} family`);
	for (const keep of ["attach", "prompt"]) assert.match(out, new RegExp(`^  ${keep} NAME`, "m"), `${keep} stays a prominent shortcut`);
	for (const name of ["snap", "snaps", "revert", "sessions", "jobs", "grants", "agent-forward", "acquire", "leases", "upgrade-host", "proxy-log"]) assert.doesNotMatch(out, new RegExp(`^  ${name}\\b`, "m"), `${name} is not in boxery help`);
	assert.match(all.out, /^Older spellings/m);
	assert.match(all.out, /^  grants NAME \[apply\].*\(= access ls \| access apply\)$/m);
	assert.deepEqual([boxery("--help").out, boxery("-h").out, boxery().out], [out, out, out]);
	assert.equal(boxery("--help", "--all").out, all.out);
	assert.equal(boxery("help", "--all", "ls").code, 2, "--all takes no command");
});

test("COMMAND --help, -h and help COMMAND work without a host", () => {
	for (const [name, e] of Object.entries(COMMANDS)) {
		if ("alias" in e || name === "help") continue;
		const r = boxery(name, "--help");
		assert.equal(r.code, 0, `${name} --help: ${r.err}`);
		assert.ok(r.out.startsWith(`Usage:\n  boxery ${name}`), `${name} --help: ${r.out}`);
		assert.equal(boxery(name, "-h").out, r.out);
		assert.equal(boxery("help", name).out, r.out);
	}
	assert.equal(boxery("list", "--help").out, boxery("ls", "--help").out, "an alias shows its command's help");
});

test("family and action help work without a host, and an older spelling's own page is unchanged", () => {
	for (const [family, e] of Object.entries(COMMANDS)) {
		if (!("actions" in e) || !e.actions) continue;
		const page = boxery(family, "--help");
		assert.ok(page.out.includes("Actions:") && page.out.includes(`boxery ${family} ACTION --help`), `${family}: ${page.out}`);
		assert.equal(boxery("help", family).out, page.out);
		assert.equal(boxery("help", family, "--help").out, page.out);
		assert.equal(boxery("help", family, "-h").code, 0);
		for (const [action, a] of Object.entries(e.actions)) {
			const r = boxery(family, action, "--help");
			assert.equal(r.code, 0, `${family} ${action}: ${r.err}`);
			assert.ok(r.out.startsWith(`Usage:\n  boxery ${family} ${action}`), `${family} ${action}: ${r.out}`);
			assert.match(page.out, new RegExp(`^  ${action.replace(/[-]/g, "\\-")}\\s`, "m"), `${family} ${action} is in the family's page`);
			assert.equal(boxery(family, action, "-h").out, r.out);
			assert.equal(boxery("help", family, action).out, r.out);
			assert.equal(boxery("help", family, action, "--help").out, r.out);
			assert.equal(boxery("help", family, action, "-h").code, 0);
			// the action shows its command's options, respelled; the command's own page is still its own
			if (a.command) {
				assert.ok(boxery(a.command, "--help").out.startsWith(`Usage:\n  boxery ${a.command}`), a.command);
				for (const line of r.out.split("\n").filter((l) => /^ {2}boxery /.test(l))) assert.ok(line.startsWith(`  boxery ${family} ${action}`), `${family} ${action}: usage line ${line}`);
			}
		}
	}
	assert.match(boxery("access", "grant", "--help").out, /--readonly/);
	assert.match(boxery("access", "ls", "--help").out, /boxery access ls demo/);
	assert.match(boxery("snap", "--help").out, /^Usage:\n {2}boxery snap NAME \[SNAP\]/);
	assert.equal(existsSync(home) && readdirSync(home).length, 0, "help wrote nothing into BOXERY_HOME");
});

test("an unknown or missing family action says which actions there are, exit 2", () => {
	let r = boxery("snapshot", "rsetore", "demo", "s1");
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, "boxery: unknown snapshot action: rsetore (did you mean restore?); actions: create, ls, restore, rm, images; see: boxery snapshot --help\n");
	assert.equal(boxery("job", "start", "demo").err, "boxery: unknown job action: start; actions: ls, logs, wait, kill; see: boxery job --help\n");
	r = boxery("lease");
	assert.equal(r.code, 2);
	assert.equal(r.err, "boxery: lease needs an action; actions: acquire, renew, release, ls; see: boxery lease --help\n");
	assert.equal(boxery("help", "access", "frob").code, 2);
	assert.match(boxery("help", "access", "frob").err, /unknown access action: frob; actions: grant, revoke, ls, apply/);
	assert.match(boxery("host", "frobnicate").err, /unknown host action: frobnicate; actions: add, ls, show, use, rm, build-base, upgrade, proxy-log, backend, backends, capabilities/);
	assert.equal(boxery("help", "access", "grant", "extra").code, 2);
});

test("an unknown command is a short error with a suggestion, exit 2", () => {
	let r = boxery("sshh");
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, "boxery: unknown command: sshh (did you mean ssh?); see: boxery help\n");
	r = boxery("frobnicate");
	assert.equal(r.err, "boxery: unknown command: frobnicate; see: boxery help\n");
	assert.equal(boxery("help", "frobnicate").code, 2);
});

test("--version and -V are boxery version", () => {
	const v = boxery("version");
	assert.equal(v.code, 0);
	assert.match(v.out, /^controller {2}\S/);
	for (const flag of ["--version", "-V"]) assert.deepEqual(boxery(flag), v, flag);
});

test("no ANSI escapes when stdout is not a terminal", () => {
	assert.doesNotMatch(boxery("help").out + boxery("run", "--help").out, /\x1b\[/);
});
