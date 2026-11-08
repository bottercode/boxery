// boxery ls: VMs, as one table. Without --host, every registered host's, a section each (the default
// first); with --host NAME, that host's. The table is drawn here from the hosts' `ls --json` (listVms), so
// every host's rows share one header and one set of column widths, and what is worth reading about a VM
// (its pool lease, outdated guest software, grants) is one STATUS column, "-" when there's nothing to say.
// Notes (VMs not checked yet, a host that failed) come after the table, on stderr.
import { describeHosts, withHost } from "../core/boxery-core.mjs";
import * as lifecycle from "../core/lifecycle.mjs";
import { BOXERY, die, hostFailed, needHost, note, quit, say, select, usage, warn } from "./lib.mjs";
/** @import { Selected } from "./lib.mjs" */

/** A row of listVms, as docs/cli.md describes `ls --json`.
 * @typedef {{ name: string, state?: string | null, ssh_addr?: string | null, tunnel?: string | null, disk_size?: number | null,
 *   disk_used?: number | null, shape?: string | null, desktop?: boolean, lease?: { state: string, holder?: string | null, expires_at?: number | null } | null,
 *   guest?: { status?: string, reasons?: string[], checked_at?: number | null }, grants: ReturnType<typeof import("../core/grant-operations.mjs").listGrants> }} Vm */
/** One host's listing, or why there is none. @typedef {{ name: string, heading: string, vms: Vm[], notes: string, error: Error | null }} Section */

const COLUMNS = ["NAME", "STATE", "SSH", "DISK", "SHAPE", "KIND", "STATUS"];
const running = (/** @type {Vm} */ vm) => ["running", "idle"].includes(vm.state ?? "");

/** ls [--json] [--refresh] [--running]. allHosts: no --host was given.
 * @param {Selected} s the selected (or default) host @param {string[]} args @param {{ allHosts: boolean }} how @returns {Promise<void>} */
export async function ls(s, args, how) {
	const { allHosts } = how;
	let json = false, refresh = false, onlyRunning = false;
	for (const a of args) {
		if (a === "--json") json = true; else if (a === "--refresh") refresh = true; else if (a === "--running") onlyRunning = true; else usage("ls");
	}
	if (json) {
		needHost(s);
		/** @type {Vm[]} */
		let vms;
		try { vms = /** @type {Vm[]} */ (await lifecycle.listVms({ refresh }, { stderr: "inherit" })); } catch (e) { hostFailed(e); }
		if (onlyRunning) vms = vms.filter(running);
		return say(vms.length ? `[\n${vms.map((v) => JSON.stringify(v)).join(",\n")}\n]` : "[]");
	}
	const hosts = allHosts ? listedHosts(s) : [];
	if (hosts.length <= 1) {
		needHost(s);
		const section = await list(s, s.host.name, "", refresh);
		if (section.error) hostFailed(section.error);
		print([section], { onlyRunning, refresh, grouped: false });
		return;
	}
	const sections = await Promise.all(hosts.map(async (h) => {
		const where = [h.backend, h.destination && (h.destination === "local" ? "on this machine" : `on ${h.destination}`)].filter(Boolean).join(" ");
		const heading = `${h.name}${h.name === s.host.name ? " (default)" : ""}${where ? `: ${where}` : ""}`;
		try {
			const hs = h.name === s.host.name ? s : await select(h.name, h.dir);
			if (!hs.config.host) die(`not configured; run: boxery setup user@host|local --name ${h.name}`);
			return await list(hs, h.name, heading, refresh);
		} catch (e) { return { name: h.name, heading, vms: [], notes: "", error: /** @type {Error} */ (e) }; }
	}));
	if (print(sections, { onlyRunning, refresh, grouped: true })) quit(1);
}

/** The hosts to list, the default first; another name registered for a host already listed (same_as) is
 *  the same host, listed once. Only the selected host when the registry can't be read. @param {Selected} s */
function listedHosts(s) {
	let hosts;
	try { hosts = describeHosts(); } catch (e) { warn(`listing ${s.host.name} only: ${/** @type {Error} */ (e).message}`); return []; }
	/** @type {typeof hosts} */
	const shown = [];
	for (const h of [...hosts.filter((h) => h.name === s.host.name), ...hosts.filter((h) => h.name !== s.host.name)]) {
		if (!h.same_as.some((n) => shown.some((o) => o.name === n))) shown.push(h);
	}
	return shown;
}

/** One host's VMs; what the host says on stderr is kept as notes, not passed through (hosts are asked at
 *  once). @param {Selected} hs @param {string} name @param {string} heading @param {boolean} refresh @returns {Promise<Section>} */
async function list(hs, name, heading, refresh) {
	/** @type {Buffer[]} */
	const notes = [];
	const onData = (/** @type {Buffer} */ d, /** @type {string} */ from) => { if (from === "stderr") notes.push(d); };
	try {
		const vms = /** @type {Vm[]} */ (await withHost(hs.host, () => lifecycle.listVms({ refresh }, { stderr: "pipe", onData })));
		return { name, heading, vms, notes: Buffer.concat(notes).toString("utf8").trim(), error: null };
	} catch (e) { return { name, heading, vms: [], notes: "", error: /** @type {Error} */ (e) }; }
}

/** The table on stdout, then the notes on stderr. Returns whether a host failed.
 * @param {Section[]} sections @param {{ onlyRunning: boolean, refresh: boolean, grouped: boolean }} how */
function print(sections, { onlyRunning, refresh, grouped }) {
	const rows = sections.map((sec) => (onlyRunning ? sec.vms.filter(running) : sec.vms).map(cells));
	const widths = COLUMNS.map((c, i) => Math.max(c.length, ...rows.flat().map((r) => r[i].length)));
	const line = (/** @type {string[]} */ r) => r.map((v, i) => (i < r.length - 1 ? v.padEnd(widths[i]) : v)).join("  ");
	const none = onlyRunning ? "(no running VMs)" : "(no VMs)";
	/** @type {string[]} */
	const out = rows.some((r) => r.length) ? [line(COLUMNS)] : [];
	/** @type {string[]} */
	const notes = [];
	for (const [i, sec] of sections.entries()) {
		if (grouped) out.push(...(i ? [""] : []), sec.heading);
		out.push(...(sec.error ? ["(ls failed: see below)"] : rows[i].length ? rows[i].map(line) : [none]));
		const who = grouped ? `${sec.name}: ` : "";
		if (sec.error) { notes.push(`boxery: ${who}${sec.error.message.replace(/^boxery: /, "") || "ls failed"}`); continue; }
		if (sec.notes) notes.push(...sec.notes.split("\n").map((l) => (grouped ? l.replace(/^(==> )?/, `$1${who}`) : l)));
		const unchecked = sec.vms.filter((v) => running(v) && v.guest?.checked_at == null).map((v) => v.name);
		if (unchecked.length && !refresh) notes.push(`==> ${who}guest software not checked yet: ${unchecked.join(", ")} (ls --refresh reads it)`);
		const outdated = sec.vms.filter((v) => v.guest?.status === "outdated").map((v) => v.name);
		if (outdated.length) notes.push(`==> ${who}outdated guest software on ${outdated.join(", ")}; update with: ${grouped ? `boxery --host ${sec.name}` : BOXERY} patch NAME|--all`);
	}
	say(out.join("\n") || none);
	if (notes.length) note(notes.join("\n"));
	return sections.some((sec) => sec.error);
}

/** A VM's row. @param {Vm} vm @returns {string[]} */
function cells(vm) {
	// A running VM whose tunnel isn't up (exe.dev, boat.dev) shows why instead of an address.
	const ssh = vm.state === "running" && vm.tunnel != null && vm.tunnel !== "up" ? `tunnel ${vm.tunnel}` : vm.ssh_addr ?? "-";
	// USED/SIZE in GiB ("0.5/40GiB"), or only the size when the backend can't tell what's used.
	const disk = vm.disk_size == null && vm.disk_used == null ? "-" : `${vm.disk_used == null ? "" : `${vm.disk_used.toFixed(1)}/`}${vm.disk_size ?? "?"}GiB`;
	return [vm.name, vm.state ?? "-", ssh, disk, vm.shape ?? "-", vm.desktop === false ? "headless" : "desktop", status(vm)];
}

/** What is worth reading about a VM, "; "-separated, or "-": its pool lease, outdated guest software, grants. @param {Vm} vm */
function status(vm) {
	/** @type {string[]} */
	const parts = [];
	const l = vm.lease;
	if (l) parts.push(l.state !== "leased" ? `pool ${l.state}` : `leased${l.holder ? ` by ${l.holder}` : ""}${l.expires_at ? `, ${left(l.expires_at)}` : ""}`);
	if (vm.guest?.status === "outdated") parts.push(`outdated guest${vm.guest.reasons?.length ? ` (${vm.guest.reasons.join(", ")})` : ""}`);
	if (vm.grants.length) parts.push(`grants ${vm.grants.map(lifecycle.grantLabel).join(",")}`);
	return parts.join("; ") || "-";
}

/** Time until an epoch-seconds expiry, short: "45m left", "3h left", "2d left", "expired". @param {number} at */
function left(at) {
	const s = at - Date.now() / 1000;
	if (s <= 0) return "expired";
	return `${s < 3600 ? `${Math.ceil(s / 60)}m` : s < 172_800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`} left`;
}
