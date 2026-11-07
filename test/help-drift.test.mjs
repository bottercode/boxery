// boxery's help can't drift from its code. Each command's help (controller/cli.mjs COMMANDS) must name exactly
// the --flags its handler compares against, examples must use real commands and documented flags, docs links
// must point at real headings, and no module keeps its own usage text. A help change shows in the golden file
// test/fixtures/boxery-help.txt (BOXERY_UPDATE_GOLDEN=1 npm test rewrites it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { COMMANDS } = await import("../controller/cli.mjs");
const { renderTop } = await import("../controller/usage.mjs");
const { HELP: OPENSHELL_HELP } = await import("../controller/setup-openshell.mjs");
const src = (/** @type {string} */ f) => readFileSync(path.join(ROOT, f), "utf8");

// Where a handler's flags are parsed, when the probe below can't follow it from the handler.
const PARSED_IN = {
	setup: [["controller/hosts.mjs", "setupNamed"], ["controller/hosts.mjs", "setupFlags"]],
	host: [["controller/hosts.mjs", "hostCommand"], ["controller/hosts.mjs", "hostLs"], ["controller/hosts.mjs", "setupFlags"]],
	grants: [["controller/grants.mjs", "grantsCommand"]],
	grant: [["core/grant-approval.mjs", "parseGrantArgs"]],
	runners: [["controller/runners-once.mjs", "runnersOnce"]],
	version: [["controller/cli.mjs", "cmdVersion"]],
};
// Flags in a handler that aren't its own options: arguments it gives ssh, gh or the VM helper.
const NOT_OPTIONS = {
	ssh: ["-t"], attach: ["-t"], forward: ["-o"],
	jobs: ["--text"], kill: ["--text"],
	runners: ["-c", "--hostname", "--jq", "--input"], // gh api
	run: ["-h", "--help"], // its own --help, handled before NAME
};
// Commands whose flags the host parses (passed through): their help is checked against the host's usage text.
const HOST_PARSED = { patch: "patch", "upgrade-host": "upgrade", backends: "backends", capabilities: "capabilities", snaps: "snaps", images: "images", pool: "pool", runners: "runners" };

/** The text of function NAME (or `case "NAME": {`) in TEXT, by brace matching. @param {string} text @param {string} name */
function body(text, name) {
	const m = new RegExp(`(?:function ${name}\\b[^{]*|case "${name}":\\s*)\\{`).exec(text);
	if (!m) return "";
	let i = m.index + m[0].length, d = 1;
	for (; i < text.length && d; i++) { if (text[i] === "{") d++; else if (text[i] === "}") d--; }
	return text.slice(m.index, i);
}

/** The --flags NAME's code compares against: its handler, the cmd* functions it calls and the module functions it imports. @param {string} name */
function flagsInCode(name) {
	const e = COMMANDS[name];
	let t = "run" in e && e.run ? e.run.toString() : "";
	for (const [, f] of t.matchAll(/\b(cmd[A-Z]\w*)\(/g)) t += body(src("controller/cli.mjs"), f);
	for (const [, mod, f] of t.matchAll(/import\("\.\/([\w-]+)\.mjs"\)\)\.(\w+)\(/g)) t += body(src(`controller/${mod}.mjs`), f);
	// leaseCommand: only this command's case
	if (/leaseCommand\(s, "(\w+)"/.test(t)) t = body(src("controller/leases.mjs"), /** @type {RegExpExecArray} */ (/leaseCommand\(s, "(\w+)"/.exec(t))[1]);
	for (const [f, fn] of PARSED_IN[name] ?? []) t += body(src(f), fn);
	const skip = new Set(NOT_OPTIONS[name] ?? []);
	return new Set([...t.matchAll(/"(--?[a-z][a-z-]*)"/g)].map((m) => m[1]).filter((f) => !skip.has(f)));
}

/** The flags a command's help documents: in its usage lines and its options (details are prose: they may mention other commands' flags). @param {import("../controller/usage.mjs").Help} h */
function flagsInHelp(h) {
	const text = [...h.usage, ...(h.flags ?? []).map(([f]) => f)].join(" ");
	return new Set([...text.matchAll(/(?<![\w-])(--?[a-z][a-z-]*)/g)].map((m) => m[1]).filter((f) => f !== "--"));
}

const commands = Object.entries(COMMANDS).flatMap(([n, e]) => ("help" in e ? [/** @type {const} */ ([n, e.help])] : []));

test("each command's help names exactly the flags its code reads", () => {
	for (const [name, h] of commands) {
		if (name in HOST_PARSED || name === "help") continue;
		const code = flagsInCode(name), help = flagsInHelp(h);
		// (setup: OpenShell's options live in its own --help)
		const undocumented = [...code].filter((f) => !help.has(f) && !(name === "setup" && OPENSHELL_HELP.includes(f)));
		const unread = [...help].filter((f) => !code.has(f) && !["--help", "-h"].includes(f));
		assert.deepEqual(undocumented, [], `boxery ${name} reads ${undocumented.join(", ")} but its help doesn't say so (controller/cli.mjs)`);
		assert.deepEqual(unread, [], `boxery ${name}'s help documents ${unread.join(", ")}, which its code never reads`);
	}
});

test("pass-through commands document the flags the host's usage gives", () => {
	const r = spawnSync(process.execPath, [path.join(ROOT, "host/cli.mjs"), "help"], { encoding: "utf8", env: { ...process.env, BOXERY_BACKEND: "fake", BOXERY_CONF: mkdtempSync(path.join(tmpdir(), "boxery-conf-")) } });
	const hostHelp = r.stdout;
	assert.ok(hostHelp.includes("boxery-host"), `boxery-host help: ${r.stderr}`);
	for (const [name, hostCmd] of Object.entries(HOST_PARSED)) {
		const lines = hostHelp.split("\n").filter((l) => new RegExp(`^  ${hostCmd}\\b|\\| ${hostCmd}\\b`).test(l));
		assert.ok(lines.length, `boxery-host help has no ${hostCmd} line`);
		const h = /** @type {import("../controller/usage.mjs").Help} */ (/** @type {{ help: object }} */ (COMMANDS[name]).help);
		const mine = flagsInHelp(h);
		// The host's admin-only flags (acquire's --holder, runners config's --api) needn't all be repeated.
		for (const f of mine) if (!["--help", "-h"].includes(f)) assert.ok(lines.join(" ").includes(f) || hostHelp.includes(f) || src("host/runners.mjs").includes(`"${f}"`), `boxery ${name} documents ${f}, which boxery-host ${hostCmd} doesn't take`);
	}
});

test("examples run real commands with documented flags", () => {
	for (const [name, h] of commands) {
		for (const [, line] of h.examples ?? []) {
			for (const part of line.split(/\s*&&\s*/)) {
				const words = part.split(/\s+/);
				assert.equal(words[0], "boxery", `${name} example: ${part}`);
				let i = 1;
				if (words[i] === "--host") i += 2;
				const cmd = words[i];
				assert.ok(Object.hasOwn(COMMANDS, cmd), `${name} example uses an unknown command: ${part}`);
				const target = /** @type {{ help: import("../controller/usage.mjs").Help }} */ (COMMANDS[cmd]);
				const documented = flagsInHelp(target.help);
				// boxery's own words: for run and ssh, up to the command they run in the VM.
				let own = words.slice(i + 1);
				if (cmd === "run" || cmd === "ssh") {
					const at = own.findIndex((w, j) => j > 0 && !w.startsWith("-") && own[j - 1] !== "--cwd");
					own = at < 0 ? own : own.slice(0, at);
				}
				for (const w of own) if (/^--?[a-z]/.test(w)) assert.ok(documented.has(w), `${name} example: ${cmd} doesn't document ${w} (${part})`);
			}
		}
	}
});

test("seeAlso names commands; docs links point at real headings", () => {
	const slug = (/** @type {string} */ t) => t.toLowerCase().replace(/<[^>]+>/g, "").replace(/[`*]/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s/g, "-");
	for (const [name, h] of commands) {
		for (const c of h.seeAlso ?? []) assert.ok(Object.hasOwn(COMMANDS, c), `${name}: seeAlso ${c} is not a command`);
		if (!h.docs) continue;
		const [file, anchor] = h.docs.split("#");
		assert.ok(readdirSync(path.join(ROOT, "docs")).includes(file), `${name}: docs/${file} doesn't exist`);
		if (anchor) {
			const slugs = src(`docs/${file}`).split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "")));
			assert.ok(slugs.includes(anchor), `${name}: docs/${file} has no heading #${anchor}`);
		}
	}
});

test("summaries are one short line", () => {
	for (const [name, h] of commands) {
		assert.ok(h.summary.length <= 66, `${name}: summary over 66 characters; put the rest in details`);
		assert.doesNotMatch(h.summary, /\n|\.$/, `${name}: summary is one line without a final period`);
		assert.match(h.usage[0], new RegExp(`^${name}\\b`), `${name}: its first usage line must start with ${name}`);
	}
});

test("no module keeps its own usage text", () => {
	for (const f of readdirSync(path.join(ROOT, "controller")).filter((f) => f.endsWith(".mjs") && f !== "usage.mjs")) {
		const hits = src(`controller/${f}`).split("\n").filter((l) => /["'`]usage: boxery (?!--host)/.test(l));
		assert.deepEqual(hits, [], `controller/${f}: use usage(COMMAND) from lib.mjs, not a literal usage line`);
	}
});

test("docs/cli.md's command reference is up to date (npm run docs:cli)", async () => {
	const { rendered } = await import("../scripts/docs-cli.mjs");
	const { text, next } = await rendered();
	assert.ok(text === next, "docs/cli.md: the command reference is out of date; run: npm run docs:cli");
});

const golden = path.join(ROOT, "test/fixtures/boxery-help.txt");
test("boxery help matches test/fixtures/boxery-help.txt (BOXERY_UPDATE_GOLDEN=1 rewrites it)", () => {
	const home = mkdtempSync(path.join(tmpdir(), "boxery-help-"));
	after(() => rmSync(home, { recursive: true, force: true }));
	const out = spawnSync(path.join(ROOT, "controller/boxery"), ["help"], { encoding: "utf8", env: { ...process.env, BOXERY_HOME: home, NO_COLOR: "1" } }).stdout;
	assert.equal(out, renderTop(COMMANDS));
	if (process.env.BOXERY_UPDATE_GOLDEN) writeFileSync(golden, out);
	assert.equal(out, readFileSync(golden, "utf8"), "boxery help changed: review it, then BOXERY_UPDATE_GOLDEN=1 node --test test/help-drift.test.mjs");
});
