// boxery sync NAME: the CLI front-end of vm_sync. It runs the same TOOLS entry as the MCP server and the
// pi extension, so the transfer, refusals and result cannot drift (docs/sync.md).
import { constants } from "node:os";
import * as core from "../core/boxery-core.mjs";
import { TOOLS } from "../core/boxery-tools.mjs";
import { die, quit, say } from "./lib.mjs";
/** @import { Tool } from "../core/boxery-tools.mjs" */
/** @import { HostProfile } from "../core/boxery-core.mjs" */

/** @param {HostProfile} host @param {string} vm @param {{ from?: string, to?: string, json?: boolean }} opts */
export async function sync(host, vm, { from, to, json = false }) {
	// Ctrl-C cancels like an MCP cancellation: before the VM applies anything, nothing changes there.
	const abort = new AbortController();
	let interrupted = 0;
	// Once the VM has started applying, the sync finishes (or rolls back) there regardless; wait for its result.
	const handlers = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]).map((sig) => /** @type {[NodeJS.Signals, () => void]} */ ([sig, () => {
		if (!interrupted) process.stderr.write("boxery: stopping; if the VM is already applying the sync, it finishes or rolls back first\n");
		interrupted = 128 + constants.signals[sig]; abort.abort();
	}]));
	for (const [sig, h] of handlers) process.on(sig, h);
	const tool = /** @type {Tool} */ (TOOLS.find((t) => t.name === "vm_sync"));
	try {
		const r = await core.withHost(host, () => tool.run(vm, { from, to }, /** @type {any} */ ({ localCwd: process.cwd(), signal: abort.signal }) /* no session: vm_sync needs none */));
		say(json ? JSON.stringify(r.structured) : r.text);
		if (r.isError) quit(1);
	} catch (/** @type {any} */ e) {
		if (e?.exitCode !== undefined) throw e;
		if (interrupted) { process.stderr.write(`boxery: ${e.message}\n`); quit(interrupted); }
		die(e.message);
	} finally { for (const [sig, h] of handlers) process.off(sig, h); }
}
