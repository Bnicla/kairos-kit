#!/usr/bin/env node
// Check that the dashboard starts on this computer and answers: it starts
// scripts/dashboard.mjs on a spare port, asks for the board, and stops it.
//
//   node scripts/check-dashboard.mjs [port]      (default 3111)
//
// The kit's CI runs it on Linux and on Windows. By hand, run it only while no
// other dashboard of this kit is running: two dev servers of one checkout
// share .next and break each other.
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.argv[2] ?? "3111";
const url = `http://127.0.0.1:${port}/`;
const windows = process.platform === "win32";

const child = spawn(process.execPath, [join(KIT, "scripts", "dashboard.mjs"), "dev", "-H", "127.0.0.1", "-p", port], {
  cwd: KIT,
  stdio: ["ignore", "pipe", "pipe"],
  // Its own process group, so that Next's own child processes stop with it.
  detached: !windows,
});
let output = "";
child.stdout.on("data", (b) => (output += b));
child.stderr.on("data", (b) => (output += b));
let ended = null;
child.on("exit", (code) => (ended = code ?? 1));

function stop() {
  if (ended !== null) return;
  if (windows) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

let status = 0;
let problem = "";
const deadline = Date.now() + 180_000;
while (Date.now() < deadline && ended === null) {
  try {
    // The first request compiles the page, which can take a while.
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    status = res.status;
    break;
  } catch (err) {
    problem = String(err?.cause?.code ?? err?.message ?? err);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
stop();

if (status >= 200 && status < 400) {
  console.log(`✓ The dashboard started and answered ${status} at ${url}`);
  process.exit(0);
}
console.error(`✗ The dashboard did not answer at ${url}` + (status ? ` (status ${status})` : ended !== null ? ` (it stopped with code ${ended})` : ` (${problem})`));
console.error(output.split("\n").slice(-40).join("\n"));
process.exit(1);
