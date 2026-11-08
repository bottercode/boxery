#!/usr/bin/env node
// Writes the command reference in docs/cli.md (between its BEGIN/END markers) from controller/cli.mjs's command
// table, the same help `boxery help` shows. `--check` fails instead when it is out of date (test/help-drift.test.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../docs/cli.md", import.meta.url));
export const BEGIN = "<!-- BEGIN generated: boxery commands (npm run docs:cli) -->";
export const END = "<!-- END generated -->";

/** docs/cli.md with its reference block rendered from the command table. */
export async function rendered() {
	const { COMMANDS } = await import("../controller/cli.mjs");
	const { renderMarkdown } = await import("../controller/usage.mjs");
	const text = readFileSync(FILE, "utf8");
	const a = text.indexOf(BEGIN), b = text.indexOf(END);
	if (a < 0 || b < a) throw new Error(`docs/cli.md: no ${BEGIN} … ${END} block`);
	return { text, next: `${text.slice(0, a + BEGIN.length)}\n\n${renderMarkdown(COMMANDS)}\n${text.slice(b)}` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const { text, next } = await rendered();
	if (process.argv.includes("--check")) {
		if (text !== next) { console.error("docs/cli.md: the command reference is out of date; run: npm run docs:cli"); process.exit(1); }
	} else if (text !== next) { writeFileSync(FILE, next); console.error("docs/cli.md: command reference updated"); }
}
