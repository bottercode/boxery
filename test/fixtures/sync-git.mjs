#!/usr/bin/env node
// git double for test/sync.test.mjs: runs the real git (REAL_GIT), except that with SYNC_SLOW_RECEIVE set,
// receive-pack (the VM end of git push) reads its input slowly and marks that it started, so a test can
// cancel a push mid-transfer.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Transform } from "node:stream";
const args = process.argv.slice(2);
const slow = process.env.SYNC_SLOW_RECEIVE && args.includes("receive-pack");
const child = spawn(/** @type {string} */ (process.env.REAL_GIT), args, { stdio: [slow ? "pipe" : "inherit", "inherit", "inherit"] });
if (slow) {
	writeFileSync(/** @type {string} */ (process.env.SYNC_SLOW_RECEIVE), String(process.pid));
	const throttle = new Transform({ transform(chunk, _e, cb) { setTimeout(() => cb(null, chunk), 20); } });
	process.stdin.pipe(throttle).pipe(/** @type {import("node:stream").Writable} */ (child.stdin));
}
for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"])) process.on(sig, () => child.kill(sig));
child.on("close", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
