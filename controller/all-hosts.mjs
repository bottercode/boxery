// Text-only, read-only listings. The CLI keeps explicit --host and JSON on their original paths.
import { withHost } from "../core/boxery-core.mjs";
import { hostRun } from "../core/profile.mjs";
import { leaseText } from "./leases.mjs";
import { controllerVersion, skewNote } from "../core/versions.mjs";
import { hostHeading, listedHosts } from "./ls.mjs";
import { needHost, note, quit, say, select, usage } from "./lib.mjs";
/** @import { Selected } from "./lib.mjs" */

/** Whether this invocation is a read-only host-wide listing (not a VM or a mutation).
 * @param {string} command @param {string[]} args */
export function isListing(command, args) {
	if (args.includes("--json")) return false;
	if (command === "pool") return args[0] === "ls";
	if (command === "runners") return !args.length || args[0] === "status";
	if (command === "upgrade-host") {
		// A flag-looking ref/value is not an action selector. Never fan out a real upgrade.
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--ref" || args[i] === "--wait") i++;
			else if (args[i] === "--check") return true;
		}
		return false;
	}
	return ["leases", "images", "version", "shapes", "capabilities", "backends"].includes(command);
}

/** Print a multi-host listing, returning false to retain the original single-host path.
 * @param {Selected} s @param {string} command @param {string[]} args */
export async function allHostsListing(s, command, args) {
	if (["leases", "version", "shapes"].includes(command) && args.length) usage(command);
	const hosts = listedHosts(s);
	if (hosts.length <= 1) return false;
	const controller = controllerVersion();
	if (command === "version") say(`controller  ${controller.version}${controller.describe ? ` (${controller.describe})` : ""}`);
	const sections = await Promise.all(hosts.map(async (h) => {
		let text = "", notes = "", error = null;
		try {
			const hs = h.name === s.host.name ? s : await select(h.name, h.dir);
			needHost(hs);
			await withHost(hs.host, async () => {
				if (command === "leases") {
					text = leaseText();
					return;
				}
				const hostCommand = command === "upgrade-host" ? "upgrade" : command;
				text = await hostRun([hostCommand, ...(command === "version" ? ["--json"] : args)], {
					host: hs.host, config: hs.config,
					onData: (d, from) => { if (from === "stderr") notes += d.toString("utf8"); },
				});
				if (command === "upgrade-host") {
					// Only --check reaches this listing path; its report is written to stderr.
					text = notes.trim();
					notes = "";
				}
				if (command === "version") {
					const h = JSON.parse(text);
					if (typeof h.version !== "string") throw new Error("invalid host version response");
					text = `host        ${h.version}${h.describe ? ` (${h.describe})` : ""}  ${h.install ?? "unknown"} install  [${hs.host.name}]`;
					const skew = skewNote(controller, h, hs.host.name);
					if (skew) notes += `boxery: ${skew}\n`;
				}
			});
		} catch (e) { error = /** @type {Error} */ (e); }
		return { name: h.name, heading: hostHeading(h, s), text, notes, error };
	}));
	if (command === "images") {
		// Keep the host's table columns and add provenance, with just one header.
		const width = Math.max(4, ...sections.map((sec) => sec.name.length));
		const row = (/** @type {string} */ host, /** @type {string} */ text) => `${host.padEnd(width)}  ${text}`;
		const header = sections.filter((sec) => !sec.error).map((sec) => sec.text.split("\n")[0]).find((line) => /^IMAGE(?:\s|$)/.test(line));
		say(row("HOST", header ?? "IMAGE"));
		for (const sec of sections) {
			if (sec.error) { say(row(sec.name, "(images failed: see below)")); continue; }
			const lines = sec.text.split("\n");
			if (/^IMAGE(?:\s|$)/.test(lines[0] ?? "")) lines.shift();
			for (const line of lines.filter(Boolean)) say(row(sec.name, line));
		}
	} else {
		say(sections.map((sec) => `${sec.heading}\n${sec.error ? `(${command} failed: see below)` : sec.text}`).join("\n\n"));
	}
	for (const sec of sections) {
		if (sec.error) note(`boxery: ${sec.name}: ${sec.error.message.replace(/^boxery: /, "") || `${command} failed`}`);
		else if (sec.notes.trim()) note(sec.notes.trim().split("\n").map((l) => l.replace(/^(==> )?/, `$1${sec.name}: `)).join("\n"));
	}
	if (sections.some((sec) => sec.error)) quit(1);
	return true;
}
