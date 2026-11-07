// CLI help, rendered from a command table: `PROG help`, `PROG COMMAND --help`, usage errors and the docs
// reference. Shared by the controller (controller/usage.mjs) and boxery-host (host/help.mjs); it imports
// nothing, like guests/ and backends/, so the host can load it without core/ (docs/host-modules.md).

export const DOCS = "https://github.com/modem-dev/boxery/blob/master/docs/";

/**
 * A command's help. `usage` lines omit the program name; the first one, without its [--flag] groups, is the
 * command's line in the list unless `list` says otherwise.
 * @typedef {object} Help
 * @property {string} group     a key of the CLI's groups
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
/**
 * A CLI: its name, its groups (in order), and what `PROG help` says around the list.
 * @typedef {object} Cli
 * @property {string} program
 * @property {Record<string, string>} groups   key → section title
 * @property {string} title     the first line of `PROG help`
 * @property {string} usage     the Usage line, without the program name
 * @property {[string, string][]} options
 * @property {string} [footer]
 * @property {string} [errorProgram]   the program name in usage errors ("" for none; default: program)
 * @property {number} [width]   the list's left column
 */

const tty = () => !!process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (/** @type {string} */ s) => (tty() ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (/** @type {string} */ s) => (tty() ? `\x1b[2m${s}\x1b[22m` : s);

/** A usage line without its option groups ("[--cwd DIR]", "[--json | --check]"): the command's shape. @param {string} line */
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
export const sentence = (s) => s.replace(/^./, (c) => c.toUpperCase());

/** Two columns: left padded to `width`; a left side longer than that keeps two spaces. @param {[string, string][]} rows @param {number} width */
function columns(rows, width, indent = "  ") {
	return rows.map(([l, r]) => `${indent}${l.length > width ? `${l}  ` : l.padEnd(width + 2)}${r}`).join("\n");
}

/** @param {Record<string, HelpEntry>} table @returns {[string, Help][]} */
const helped = (table) => Object.entries(table).flatMap(([n, e]) => (e.help ? [/** @type {[string, Help]} */ ([n, e.help])] : []));

/** `PROG help`. @param {Cli} cli @param {Record<string, HelpEntry>} table */
export function renderTop(cli, table) {
	const entries = helped(table), width = cli.width ?? 28;
	const sections = Object.entries(cli.groups).flatMap(([g, title]) => {
		const rows = entries.filter(([, h]) => h.group === g).map(([n, h]) => /** @type {[string, string]} */ ([listLine(n, h), sentence(h.summary)]));
		return rows.length ? [`${bold(`${title}:`)}\n${columns(rows, width)}`] : [];
	});
	return `${cli.title}

${bold("Usage:")}
  ${cli.program} ${cli.usage}

${sections.join("\n\n")}

${bold("Options:")}
${columns(cli.options, width)}
${cli.footer ? `\n${cli.footer}\n` : ""}`;
}

/** `PROG COMMAND --help`. @param {Cli} cli @param {string} _name @param {Help} h */
export function renderCommand(cli, _name, h) {
	const out = [`${bold("Usage:")}\n${h.usage.map((u) => `  ${cli.program} ${u}`).join("\n")}`, `${sentence(h.summary)}.`];
	if (h.details?.length) out.push(h.details.join("\n\n"));
	if (h.flags?.length) out.push(`${bold("Options:")}\n${columns(h.flags, Math.min(24, Math.max(...h.flags.map(([f]) => f.length))))}`);
	if (h.examples?.length) out.push(`${bold("Examples:")}\n${h.examples.map(([c, l]) => `  ${dim(`# ${c}`)}\n  ${l}`).join("\n\n")}`);
	const more = [h.seeAlso?.length ? `See also: ${h.seeAlso.map((c) => `${cli.program} ${c}`).join(", ")}` : "", h.docs ? `Docs: ${DOCS}${h.docs}` : ""].filter(Boolean);
	if (more.length) out.push(more.join("\n"));
	return `${out.join("\n\n")}\n`;
}

/** A command reference for docs/ (scripts/docs-cli.mjs writes it between markers): a table per group. @param {Cli} cli @param {Record<string, HelpEntry>} table @param {string} page the docs page it goes in */
export function renderMarkdown(cli, table, page) {
	const cell = (/** @type {string} */ s) => s.replaceAll("|", "\\|");
	const aliases = Object.entries(table).flatMap(([n, e]) => (e.alias ? [[n, e.alias]] : []));
	const sections = Object.entries(cli.groups).flatMap(([g, title]) => {
		const rows = helped(table).filter(([, h]) => h.group === g).map(([n, h]) => {
			const also = aliases.filter(([, t]) => t === n).map(([a]) => ` (also: \`${a}\`)`).join("");
			const link = h.docs ? ` [→](${h.docs.startsWith(`${page}#`) ? h.docs.slice(page.length) : h.docs})` : "";
			return `| ${h.usage.map((u) => `\`${cli.program} ${cell(u)}\``).join("<br>")} | ${cell(sentence(h.summary))}${also}${link} |`;
		});
		return rows.length ? [`**${title}**\n\n| Command | What it does |\n|---|---|\n${rows.join("\n")}`] : [];
	});
	return `${sections.join("\n\n")}\n`;
}

/**
 * A usage error's message, from the command's usage lines: those of subcommand SUB when given ("host use",
 * "runners once"), else all of them. HINT goes after, in parentheses.
 * @param {Cli} cli @param {Record<string, HelpEntry>} table @param {string} name @param {{ sub?: string, hint?: string }} [opts]
 */
export function usageText(cli, table, name, { sub, hint } = {}) {
	const h = Object.hasOwn(table, name) ? table[name].help : undefined;
	let lines = h?.usage ?? [name];
	if (sub) lines = lines.filter((u) => u === `${name} ${sub}` || u.startsWith(`${name} ${sub} `));
	if (!lines.length) throw new Error(`no usage line for ${name} ${sub}`);
	const prog = cli.errorProgram ?? cli.program, p = prog ? `${prog} ` : "";
	return `usage: ${lines.map((u) => `${p}${u}`).join(`\n       `)}${hint ? `   (${hint})` : ""}`;
}

/** The command NAME means (an alias's target), or null. @param {Record<string, HelpEntry>} table @param {string} name */
export function resolve(table, name) {
	if (!Object.hasOwn(table, name)) return null;
	const e = table[name];
	return e.alias ? (Object.hasOwn(table, e.alias) ? e.alias : null) : name;
}

/** "unknown command", with the nearest command when there is a close one. @param {Cli} cli @param {Record<string, HelpEntry>} table @param {string} word */
export function unknownCommand(cli, table, word) {
	const names = Object.keys(table).filter((n) => !n.startsWith("_"));
	const near = names.map((n) => /** @type {const} */ ([n, distance(word, n)])).filter(([n, d]) => d <= Math.max(1, Math.floor(n.length / 3)) || (word.length >= 3 && n.startsWith(word))).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0];
	return `unknown command: ${word}${near ? ` (did you mean ${near[0]}?)` : ""}; see: ${cli.program} help`;
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
