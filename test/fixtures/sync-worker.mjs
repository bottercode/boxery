// One vm_sync call in its own process (core reads BOXERY_HOME at import), against the fake SSH endpoints
// of test/fixtures/copy-ssh.mjs. argv: VM, then JSON {from, to, local?}. IPC "abort" cancels.
import { withHost } from "../../core/boxery-core.mjs";
import { syncTool } from "../../core/sync.mjs";
const [vm, settings = "{}"] = process.argv.slice(2);
const { local, ...params } = JSON.parse(settings);
const ac = new AbortController();
process.on("message", (m) => { if (m === "abort") ac.abort(); });
process.once("disconnect", () => ac.abort());
/** @type {any} */
let result;
try {
	result = { ok: true, ...(await withHost("alpha", () => syncTool(vm, params, { signal: ac.signal, local }))) };
} catch (e) {
	result = { ok: false, error: /** @type {Error} */ (e).message, name: /** @type {Error} */ (e).name };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (process.connected) process.disconnect();
