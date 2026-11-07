// The controller's help (boxery help, boxery COMMAND --help), rendered by help/index.mjs from the command table
// in cli.mjs: each command's `help` sits next to its handler, so the list, the per-command pages and the usage
// line all come from one place. Nothing here knows a command by name.
import * as help from "../help/index.mjs";
/** @typedef {import("../help/index.mjs").Help} Help */
/** @typedef {import("../help/index.mjs").HelpEntry} HelpEntry */

/** Sections of `boxery help`, in order. */
export const GROUPS = {
	setup: "Setup & hosts",
	vms: "VMs",
	snapshots: "Snapshots & images",
	use: "Work in a VM",
	jobs: "Background jobs",
	access: "Access (grants)",
	pool: "Shared pool & runners",
	admin: "Host & diagnostics",
};

/** @type {import("../help/index.mjs").Cli} */
export const CLI = {
	program: "boxery",
	groups: GROUPS,
	title: "boxery — remote desktop VMs for coding agents",
	usage: "[--host NAME] COMMAND [ARGS...]",
	options: [
		["--host NAME", "Run COMMAND on a host other than the default (boxery host use)"],
		["--json", "JSON output on listings (fields: docs/cli.md#json-output)"],
		["-h, --help", "Show help; boxery COMMAND --help shows a command's"],
	],
	footer: `Docs: ${help.DOCS}cli.md\nAgents: prefer the vm_* tools (boxery-mcp or the pi extension): ${help.DOCS}mcp.md`,
};

export const { shape, listLine } = help;
/** `boxery help`. @param {Record<string, HelpEntry>} table */
export const renderTop = (table) => help.renderTop(CLI, table);
/** `boxery COMMAND --help`. @param {string} name @param {Help} h */
export const renderCommand = (name, h) => help.renderCommand(CLI, name, h);
/** docs/cli.md's command reference. @param {Record<string, HelpEntry>} table */
export const renderMarkdown = (table) => help.renderMarkdown(CLI, table, "cli.md");
/** @param {Record<string, HelpEntry>} table @param {string} name */
export const resolve = (table, name) => help.resolve(table, name);
/** @param {Record<string, HelpEntry>} table @param {string} word */
export const unknownCommand = (table, word) => help.unknownCommand(CLI, table, word);

/** The command table (cli.mjs registers it as it loads), for usage errors raised in the modules it calls. @type {Record<string, HelpEntry>} */
let TABLE = {};
/** @param {Record<string, HelpEntry>} table */
export function registerCommands(table) { TABLE = table; }
/** A usage error's message (help/index.mjs usageText). @param {string} name @param {{ sub?: string, hint?: string }} [opts] */
export const usageText = (name, opts) => help.usageText(CLI, TABLE, name, opts);
