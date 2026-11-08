// boxery help: rendered from controller/cli.mjs's command table, and usable before any host is set up.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

test("every command is listed in boxery help, in a known group", () => {
	const { code, out } = boxery("help");
	assert.equal(code, 0);
	for (const [name, e] of Object.entries(COMMANDS)) {
		if ("alias" in e) continue;
		assert.ok(e.help.group in GROUPS, `${name}: unknown group ${e.help.group}`);
		assert.match(out, new RegExp(`^  ${name.replace(/[-]/g, "\\-")}\\b`, "m"), `${name} is missing from boxery help`);
	}
	assert.deepEqual([boxery("--help").out, boxery("-h").out, boxery().out], [out, out, out]);
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

test("an unknown command is a short error with a suggestion, exit 2", () => {
	let r = boxery("sshh");
	assert.equal(r.code, 2);
	assert.equal(r.out, "");
	assert.equal(r.err, "boxery: unknown command: sshh (did you mean ssh?); see: boxery help\n");
	r = boxery("frobnicate");
	assert.equal(r.err, "boxery: unknown command: frobnicate; see: boxery help\n");
	assert.equal(boxery("help", "frobnicate").code, 2);
});

test("no ANSI escapes when stdout is not a terminal", () => {
	assert.doesNotMatch(boxery("help").out + boxery("run", "--help").out, /\x1b\[/);
});
