// The controller's help (boxery help, boxery COMMAND --help), rendered from the command table in cli.mjs:
// each command's `help` sits next to its handler, so the list, the per-command pages and the usage line
// all come from one place. Nothing here knows a command by name.

const DOCS = "https://github.com/modem-dev/boxery/blob/master/docs/";

/** Sections of `boxery help`, in order. */
export const GROUPS = /** @type {const} */ ({
	setup: "Setup & hosts",
	vms: "VMs",
	snapshots: "Snapshots & images",
	use: "Work in a VM",
	jobs: "Background jobs",
	access: "Access (grants)",
	pool: "Shared pool & runners",
	admin: "Host & diagnostics",
});

/**
 * A command's help. `usage` lines omit the leading "boxery "; the first one, without its [--flag] groups,
 * is the command's line in `boxery help` unless `list` says otherwise.
 * @typedef {object} Help
 * @property {keyof typeof GROUPS} group
 * @property {string[]} usage
 * @property {string} summary   one line, for the list
 * @property {string} [list]    the list's left column, when usage[0] without its flags doesn't fit
 * @property {string[]} [details]   paragraphs for COMMAND --help
 * @property {[string, string][]} [flags]   [flag with its value, what it does]
 * @property {[string, string][]} [examples]   [comment, command line]
 * @property {string[]} [seeAlso]
 * @property {string} [docs]    page#anchor under docs/
 */
/** @typedef {{ help?: Help, alias?: string }} HelpEntry */

const tty = () => !!process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (/** @type {string} */ s) => (tty() ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (/** @type {string} */ s) => (tty() ? `\x1b[2m${s}\x1b[22m` : s);

/** usage[0] without its option groups ("[--cwd DIR]", "[--json | --check]"): the command's shape. @param {string} line */
export function shape(line) {
	let out = "", depth = 0, skip = -1;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "[") { if (skip < 0 && line[i + 1] === "-") skip = depth; depth++; if (skip >= 0) continue; }
		else if (c === "]") {
			depth--;
			if (skip >= 0) { if (depth === skip) { skip = -1; if (line.startsWith("...", i + 1)) i += 3; } continue; } // (a repeated flag: [--grant SPEC]...)
		}
		else if (skip >= 0) continue;
		out += c;
	}
	return out.replace(/\s+/g, " ").trim();
}

/** @param {string} name @param {Help} h */
export const listLine = (name, h) => h.list ?? shape(h.usage[0] ?? name);

/** A summary as the start of a sentence. @param {string} s */
const sentence = (s) => s.replace(/^./, (c) => c.toUpperCase());

/** Two columns: left padded to `width`; a left side longer than that keeps two spaces. @param {[string, string][]} rows @param {number} width */
function columns(rows, width, indent = "  ") {
	return rows.map(([l, r]) => `${indent}${l.length > width ? `${l}  ` : l.padEnd(width + 2)}${r}`).join("\n");
}

/** `boxery help`. @param {Record<string, HelpEntry>} table */
export function renderTop(table) {
	const entries = Object.entries(table).flatMap(([n, e]) => (e.help ? [/** @type {[string, Help]} */ ([n, e.help])] : []));
	const width = 28;
	const sections = Object.entries(GROUPS).flatMap(([g, title]) => {
		const rows = entries.filter(([, h]) => h.group === g).map(([n, h]) => /** @type {[string, string]} */ ([listLine(n, h), sentence(h.summary)]));
		return rows.length ? [`${bold(`${title}:`)}\n${columns(rows, width)}`] : [];
	});
	return `boxery — remote desktop VMs for coding agents

${bold("Usage:")}
  boxery [--host NAME] COMMAND [ARGS...]

${sections.join("\n\n")}

${bold("Options:")}
${columns([
		["--host NAME", "Run COMMAND on a host other than the default (boxery host use)"],
		["--json", "JSON output on listings (fields: docs/cli.md#json-output)"],
		["-h, --help", "Show help; boxery COMMAND --help shows a command's"],
	], width)}

Docs: ${DOCS}cli.md
Agents: prefer the vm_* tools (boxery-mcp or the pi extension): ${DOCS}mcp.md
`;
}

/** The command reference in docs/cli.md (scripts/docs-cli.mjs writes it between its markers). @param {Record<string, HelpEntry>} table */
export function renderMarkdown(table) {
	const cell = (/** @type {string} */ s) => s.replaceAll("|", "\\|");
	const entries = Object.entries(table).flatMap(([n, e]) => (e.help ? [/** @type {[string, Help]} */ ([n, e.help])] : []));
	const aliases = Object.entries(table).flatMap(([n, e]) => (e.alias ? [[n, e.alias]] : []));
	const sections = Object.entries(GROUPS).flatMap(([g, title]) => {
		const rows = entries.filter(([, h]) => h.group === g).map(([n, h]) => {
			const also = aliases.filter(([, t]) => t === n).map(([a]) => ` (also: \`${a}\`)`).join("");
			const link = h.docs ? ` [→](${h.docs.startsWith("cli.md#") ? h.docs.slice(6) : h.docs})` : "";
			return `| ${h.usage.map((u) => `\`boxery ${cell(u)}\``).join("<br>")} | ${cell(sentence(h.summary))}${also}${link} |`;
		});
		return rows.length ? [`**${title}**\n\n| Command | What it does |\n|---|---|\n${rows.join("\n")}`] : [];
	});
	return `${sections.join("\n\n")}\n`;
}

/** `boxery COMMAND --help`. @param {string} name @param {Help} h */
export function renderCommand(name, h) {
	const out = [`${bold("Usage:")}\n${h.usage.map((u) => `  boxery ${u}`).join("\n")}`, `${sentence(h.summary)}.`];
	if (h.details?.length) out.push(h.details.join("\n\n"));
	if (h.flags?.length) out.push(`${bold("Options:")}\n${columns(h.flags, Math.min(24, Math.max(...h.flags.map(([f]) => f.length))))}`);
	if (h.examples?.length) out.push(`${bold("Examples:")}\n${h.examples.map(([c, l]) => `  ${dim(`# ${c}`)}\n  ${l}`).join("\n\n")}`);
	const more = [h.seeAlso?.length ? `See also: ${h.seeAlso.map((c) => `boxery ${c}`).join(", ")}` : "", h.docs ? `Docs: ${DOCS}${h.docs}` : ""].filter(Boolean);
	if (more.length) out.push(more.join("\n"));
	return `${out.join("\n\n")}\n`;
}

/** The command table (cli.mjs registers it as it loads), for usage errors raised in the modules it calls. @type {Record<string, HelpEntry>} */
let TABLE = {};
/** @param {Record<string, HelpEntry>} table */
export function registerCommands(table) { TABLE = table; }

/**
 * A usage error's message, from the command's usage lines: those of subcommand SUB when given
 * ("host use", "runners once"), else all of them. HINT goes after, in parentheses.
 * @param {string} name @param {{ sub?: string, hint?: string }} [opts]
 */
export function usageText(name, { sub, hint } = {}) {
	const h = Object.hasOwn(TABLE, name) ? TABLE[name].help : undefined;
	let lines = h?.usage ?? [name];
	if (sub) lines = lines.filter((u) => u === `${name} ${sub}` || u.startsWith(`${name} ${sub} `));
	if (!lines.length) throw new Error(`no usage line for ${name} ${sub}`);
	return `usage: ${lines.map((u) => `boxery ${u}`).join("\n       ")}${hint ? `   (${hint})` : ""}`;
}

/** The command NAME means (an alias's target), or null. @param {Record<string, HelpEntry>} table @param {string} name */
export function resolve(table, name) {
	if (!Object.hasOwn(table, name)) return null;
	const e = table[name];
	return e.alias ? (Object.hasOwn(table, e.alias) ? e.alias : null) : name;
}

/** "unknown command", with the nearest command when there is a close one. @param {Record<string, HelpEntry>} table @param {string} word */
export function unknownCommand(table, word) {
	const names = Object.keys(table).filter((n) => !n.startsWith("__"));
	const near = names.map((n) => /** @type {const} */ ([n, distance(word, n)])).filter(([n, d]) => d <= Math.max(1, Math.floor(n.length / 3)) || (word.length >= 3 && n.startsWith(word))).sort((a, b) => a[1] - b[1])[0];
	return `unknown command: ${word}${near ? ` (did you mean ${near[0]}?)` : ""}; see: boxery help`;
}

/** Levenshtein distance. @param {string} a @param {string} b */
function distance(a, b) {
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		prev = row;
	}
	return prev[b.length];
}
