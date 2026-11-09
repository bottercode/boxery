// The controller's help (boxery help, boxery COMMAND --help), rendered by help/index.mjs from the command table
// in cli.mjs: each command's `help` sits next to its handler, so the list, the per-command pages and the usage
// line all come from one place. Nothing here knows a command by name.
import * as help from "../help/index.mjs";
/** @typedef {import("../help/index.mjs").Help} Help */
/** @typedef {import("../help/index.mjs").HelpEntry} HelpEntry */

/** Sections of `boxery help`, in order. `legacy` (older spellings) and each family's actions only show in `boxery help --all`. */
export const GROUPS = {
	start: "Getting started",
	vms: "VMs",
	use: "Work in a VM",
	families: "Command families (boxery FAMILY --help)",
	more: "More",
	legacy: "Older spellings (still work; the same commands as the family actions)",
};

/** @type {import("../help/index.mjs").Cli} */
export const CLI = {
	program: "boxery",
	groups: GROUPS,
	hidden: ["legacy"],
	families: "families",
	width: 36,
	title: "boxery — remote desktop VMs for coding agents",
	usage: "[--host NAME] COMMAND [ARGS...]",
	options: [
		["--host NAME", "Run COMMAND on a host other than the default (boxery host use)"],
		["--json", "JSON output on listings (fields: docs/cli.md#json-output)"],
		["-h, --help", "Show help; boxery COMMAND --help shows a command's"],
		["help --all", "Every command, every family action and every older spelling"],
	],
	footer: `Docs: ${help.DOCS}cli.md\nAgents: prefer the vm_* tools (boxery-mcp or the pi extension): ${help.DOCS}mcp.md`,
};

export const { shape, listLine } = help;
/** `boxery help`; all: `boxery help --all`. @param {Record<string, HelpEntry>} table @param {boolean} [all] */
export const renderTop = (table, all = false) => help.renderTop(CLI, table, all);
/** `boxery FAMILY --help`. @param {Record<string, HelpEntry>} table @param {string} family */
export const renderFamily = (table, family) => help.renderFamily(CLI, table, family);
/** `boxery FAMILY ACTION --help`, or null when the family has no such action. @param {Record<string, HelpEntry>} table @param {string} family @param {string} action */
export const actionHelp = (table, family, action) => help.actionHelp(CLI, table, family, action);
/** What boxery says to a family's unknown (or missing) action. @param {Record<string, HelpEntry>} table @param {string} family @param {string} [word] */
export const unknownAction = (table, family, word) => help.unknownAction(CLI, table, family, word);
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
/** A copyable canonical command, checked against the same table used for dispatch and help.
 *  @param {string} command @param {string[]} [args] @param {string[]} [prefix] */
export const commandRef = (command, args = [], prefix = []) => help.commandRef(CLI, TABLE, command, args, prefix);

/** A family's usage lines are its actions' (and its `list` the action names): filled in here, so the two can't differ. @param {Record<string, HelpEntry>} table */
export function registerCommands(table) {
	TABLE = table;
	for (const [name, e] of Object.entries(table)) {
		if (!e.actions || !e.help) continue;
		const names = Object.keys(e.actions);
		e.help.usage = names.flatMap((a) => actionHelp(table, name, a)?.usage ?? []);
		e.help.list ??= `${name} ${names.join("|")}`;
	}
}

/** The family action the running command was reached through (`boxery job logs` runs `logs`), so its usage errors say how it was typed. @type {{ command: string, family: string, action: string } | null} */
let ROUTE = null;
/** @param {string} command @param {string} family @param {string} action */
export function routedThrough(command, family, action) { ROUTE = { command, family, action }; }
/** A usage error's message (help/index.mjs usageText). @param {string} name @param {{ sub?: string, hint?: string }} [opts] */
export const usageText = (name, opts) => (ROUTE?.command === name && !opts?.sub ? help.usageText(CLI, TABLE, ROUTE.family, { ...opts, sub: ROUTE.action }) : help.usageText(CLI, TABLE, name, opts));
