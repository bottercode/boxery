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
/**
 * One action of a command family (`boxery snapshot create`). `command` names the command whose handler runs it:
 * the action's help is that command's, respelled (its usage lines, examples and see-also start with
 * "snapshot create" instead of "snap"). `help` replaces what doesn't fit. An action without `command` is
 * the family's own (host's registry actions).
 * @typedef {object} Action
 * @property {string} [command]
 * @property {Partial<Help>} [help]
 */
/** @typedef {{ help?: Help, alias?: string, actions?: Record<string, Action> }} HelpEntry */
/**
 * A CLI: its name, its groups (in order), and what `PROG help` says around the list.
 * @typedef {object} Cli
 * @property {string} program
 * @property {Record<string, string>} groups   key → section title, in the order `PROG help` lists them
 * @property {string[]} [hidden]   groups only `PROG help --all` lists (older spellings)
 * @property {string} [families]   the group of the command families: `help --all` follows it with a section for each family's actions
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

/** The family actions a command's handler also serves (grants serves both access ls and access apply). @param {Record<string, HelpEntry>} table @param {string} command */
function familyActions(table, command) {
	return Object.entries(table).flatMap(([f, e]) => Object.entries(e.actions ?? {}).flatMap(([a, x]) => x.command === command ? [`${f} ${a}`] : []));
}

/** How a see-also names COMMAND: by its family action when the command is an older spelling, else as is. @param {Cli} cli @param {Record<string, HelpEntry>} table @param {string} command */
function spelling(cli, table, command) {
	const [fa] = familyActions(table, command);
	return fa && cli.hidden?.includes(table[command]?.help?.group ?? "") ? fa : command;
}

/**
 * The help of FAMILY's ACTION, or null: its command's, respelled as the action unless the action says otherwise.
 * @param {Cli} cli @param {Record<string, HelpEntry>} table @param {string} family @param {string} action @returns {Help | null}
 */
export function actionHelp(cli, table, family, action) {
	const actions = Object.hasOwn(table, family) ? table[family].actions : undefined;
	if (!actions || !Object.hasOwn(actions, action)) return null;
	const a = actions[action], name = `${family} ${action}`;
	const base = a.command ? table[a.command]?.help : undefined;
	const h = { ...base, ...a.help };
	const { summary, usage } = h;
	if (!summary || !usage) throw new Error(`${name}: no help (an action without a command needs a summary and usage)`);
	const start = a.command ? new RegExp(`^(${cli.program} (?:--host \\S+ )?)?${a.command}(?=\\s|$)`) : null;
	const respell = (/** @type {string} */ line) => (start ? line.replace(start, (_, p = "") => `${p}${name}`) : line);
	return {
		...h, summary, group: table[family].help?.group ?? "",
		usage: a.help?.usage ?? usage.map(respell),
		list: a.help?.list ?? (h.list && !a.help?.usage ? respell(h.list) : undefined),
		examples: a.help?.examples ?? h.examples?.map(([c, l]) => /** @type {[string, string]} */ ([c, respell(l)])),
		seeAlso: a.help?.seeAlso ?? h.seeAlso?.map((c) => spelling(cli, table, c)),
	};
}

/** @typedef {{ left: string, usage: string[], text: string, docs?: string, name: string }} Row */
/** The command list as sections of rows: `PROG help`'s, and with ALL (`help --all`) also each family's actions and the hidden groups. @param {Cli} cli @param {Record<string, HelpEntry>} table @param {boolean} all @returns {{ title: string, rows: Row[] }[]} */
function sections(cli, table, all) {
	const entries = helped(table);
	/** @type {{ title: string, rows: Row[] }[]} */
	const out = [];
	for (const [g, title] of Object.entries(cli.groups)) {
		if (!all && cli.hidden?.includes(g)) continue;
		const rows = entries.filter(([, h]) => h.group === g).map(([n, h]) => {
			const fa = familyActions(table, n).join(" | ");
			return { name: n, left: listLine(n, h), usage: h.usage, text: `${sentence(h.summary)}${fa ? ` (= ${fa})` : ""}`, docs: h.docs };
		});
		if (rows.length) out.push({ title, rows });
		if (!all || g !== cli.families) continue;
		for (const [f, e] of Object.entries(table)) {
			if (!e.actions || !e.help || e.help.group !== g) continue;
			const acts = Object.keys(e.actions).flatMap((a) => { const h = actionHelp(cli, table, f, a); return h ? [[a, h]] : []; });
			out.push({ title: `${cli.program} ${f} — ${e.help.summary}`, rows: acts.map(([a, h]) => ({ name: `${f} ${a}`, left: listLine(`${f} ${a}`, /** @type {Help} */ (h)), usage: /** @type {Help} */ (h).usage, text: sentence(/** @type {Help} */ (h).summary), docs: /** @type {Help} */ (h).docs })) });
		}
	}
	return out;
}

/** `PROG help`; with ALL, `PROG help --all`. @param {Cli} cli @param {Record<string, HelpEntry>} table */
export function renderTop(cli, table, all = false) {
	const width = cli.width ?? 28;
	const list = sections(cli, table, all).map(({ title, rows }) => `${bold(`${title}:`)}\n${columns(rows.map((r) => [r.left, r.text]), width)}`);
	return `${cli.title}

${bold("Usage:")}
  ${cli.program} ${cli.usage}

${list.join("\n\n")}

${bold("Options:")}
${columns(cli.options, width)}
${cli.footer ? `\n${cli.footer}\n` : ""}`;
}

/** A help page's last parts: examples, see-also and docs, after OUT. @param {Cli} cli @param {string[]} out @param {Help} h */
function page(cli, out, h) {
	if (h.examples?.length) out.push(`${bold("Examples:")}\n${h.examples.map(([c, l]) => `  ${dim(`# ${c}`)}\n  ${l}`).join("\n\n")}`);
	const more = [h.seeAlso?.length ? `See also: ${h.seeAlso.map((c) => `${cli.program} ${c}`).join(", ")}` : "", h.docs ? `Docs: ${DOCS}${h.docs}` : ""].filter(Boolean);
	if (more.length) out.push(more.join("\n"));
	return `${out.join("\n\n")}\n`;
}

/** `PROG COMMAND --help`. @param {Cli} cli @param {string} _name @param {Help} h */
export function renderCommand(cli, _name, h) {
	const out = [`${bold("Usage:")}\n${h.usage.map((u) => `  ${cli.program} ${u}`).join("\n")}`, `${sentence(h.summary)}.`];
	if (h.details?.length) out.push(h.details.join("\n\n"));
	if (h.flags?.length) out.push(`${bold("Options:")}\n${columns(h.flags, Math.min(24, Math.max(...h.flags.map(([f]) => f.length))))}`);
	return page(cli, out, h);
}

/** `PROG FAMILY --help`: its actions, then what a command's page has. @param {Cli} cli @param {Record<string, HelpEntry>} table @param {string} family */
export function renderFamily(cli, table, family) {
	const h = /** @type {Help} */ (table[family].help), names = Object.keys(table[family].actions ?? {});
	const rows = names.map((a) => /** @type {[string, string]} */ ([a, sentence(actionHelp(cli, table, family, a)?.summary ?? "")]));
	const out = [`${bold("Usage:")}\n${h.usage.map((u) => `  ${cli.program} ${u}`).join("\n")}`, `${sentence(h.summary)}.`];
	if (h.details?.length) out.push(h.details.join("\n\n"));
	out.push(`${bold("Actions:")}\n${columns(rows, Math.max(...names.map((a) => a.length)))}\n\n${cli.program} ${family} ACTION --help shows an action's options.`);
	return page(cli, out, h);
}

/** A command reference for docs/ (scripts/docs-cli.mjs writes it between markers): a table per section. @param {Cli} cli @param {Record<string, HelpEntry>} table @param {string} page the docs page it goes in */
export function renderMarkdown(cli, table, page) {
	const cell = (/** @type {string} */ s) => s.replaceAll("|", "\\|");
	const aliases = Object.entries(table).flatMap(([n, e]) => (e.alias ? [[n, e.alias]] : []));
	const parts = sections(cli, table, true).map(({ title, rows }) => {
		const lines = rows.map((r) => {
			const also = aliases.filter(([, t]) => t === r.name).map(([a]) => ` (also: \`${a}\`)`).join("");
			const link = r.docs ? ` [→](${r.docs.startsWith(`${page}#`) ? r.docs.slice(page.length) : r.docs})` : "";
			return `| ${r.usage.map((u) => `\`${cli.program} ${cell(u)}\``).join("<br>")} | ${cell(r.text)}${also}${link} |`;
		});
		return `**${title}**\n\n| Command | What it does |\n|---|---|\n${lines.join("\n")}`;
	});
	return `${parts.join("\n\n")}\n`;
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

/** The name nearest WORD, when one is close. @param {string} word @param {string[]} names */
function nearest(word, names) {
	return names.map((n) => /** @type {const} */ ([n, distance(word, n)])).filter(([n, d]) => d <= Math.max(1, Math.floor(n.length / 3)) || (word.length >= 3 && n.startsWith(word))).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0];
}

/** "unknown command", with the nearest command when there is a close one. @param {Cli} cli @param {Record<string, HelpEntry>} table @param {string} word */
export function unknownCommand(cli, table, word) {
	const near = nearest(word, Object.keys(table).filter((n) => !n.startsWith("_")));
	return `unknown command: ${word}${near ? ` (did you mean ${near[0]}?)` : ""}; see: ${cli.program} help`;
}

/** What a family says to an action it doesn't have (WORD) or to none: its actions and where to read more. @param {Cli} cli @param {Record<string, HelpEntry>} table @param {string} family @param {string} [word] */
export function unknownAction(cli, table, family, word) {
	const names = Object.keys(table[family].actions ?? {}), near = word === undefined ? undefined : nearest(word, names);
	const what = word === undefined ? `${family} needs an action` : `unknown ${family} action: ${word}${near ? ` (did you mean ${near[0]}?)` : ""}`;
	return `${what}; actions: ${names.join(", ")}; see: ${cli.program} ${family} --help`;
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
