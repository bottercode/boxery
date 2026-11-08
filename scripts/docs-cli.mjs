#!/usr/bin/env node
// Writes the command references in docs/cli.md (between their BEGIN/END markers) from the command tables, the
// same help `boxery help` and `boxery-host help` show. `--check` fails instead when one is out of date
// (test/help-drift.test.mjs runs the same check).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../docs/cli.md", import.meta.url));
const END = "<!-- END generated -->";

/** docs/cli.md with its reference blocks rendered from the command tables. */
export async function rendered() {
	const { COMMANDS } = await import("../controller/cli.mjs");
	const { renderMarkdown } = await import("../controller/usage.mjs");
	const { hostMarkdown } = await import("../host/help.mjs");
	const blocks = { "boxery commands": renderMarkdown(COMMANDS), "boxery-host commands": hostMarkdown() };
	const text = readFileSync(FILE, "utf8");
	let next = text;
	for (const [name, md] of Object.entries(blocks)) {
		const begin = `<!-- BEGIN generated: ${name} (npm run docs:cli) -->`;
		const a = next.indexOf(begin), b = next.indexOf(END, a);
		if (a < 0 || b < a) throw new Error(`docs/cli.md: no ${begin} … ${END} block`);
		next = `${next.slice(0, a + begin.length)}\n\n${md}\n${next.slice(b)}`;
	}
	return { text, next };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const { text, next } = await rendered();
	if (process.argv.includes("--check")) {
		if (text !== next) { console.error("docs/cli.md: a command reference is out of date; run: npm run docs:cli"); process.exit(1); }
	} else if (text !== next) { writeFileSync(FILE, next); console.error("docs/cli.md: command references updated"); }
}
