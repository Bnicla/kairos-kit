#!/usr/bin/env node
// Kairos Kit dashboard, started the same way on macOS, Linux and Windows.
//
//   node scripts/dashboard.mjs dev -H 127.0.0.1 [-p 3000]     (what `npm run dev` runs)
//   node scripts/dashboard.mjs start -H 127.0.0.1             (what `npm start` runs)
//
// It turns the access check on (KAIROS_LOCAL_ONLY=1, apps/local/proxy.ts) and
// starts Next from apps/local. The package scripts used to set that variable in
// the command itself ("KAIROS_LOCAL_ONLY=1 next dev"), a form Windows does not
// have. Everything after the first word is passed to Next unchanged. Run only
// one dashboard per checkout: two dev servers share .next and break each other.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(KIT, "apps", "local");
const [mode = "dev", ...rest] = process.argv.slice(2);
if (mode !== "dev" && mode !== "start") {
  console.error("Usage: node scripts/dashboard.mjs dev|start [options for Next, such as -H 127.0.0.1 -p 3000]");
  process.exit(2);
}

let next;
try {
  // Next's own entry file, run with this Node: no npx, which on Windows is a .cmd file.
  next = createRequire(join(APP, "package.json")).resolve("next/dist/bin/next");
} catch {
  console.error("Next.js is not installed. Run the installer first (./install.sh on a Mac, node install.mjs on Windows).");
  process.exit(1);
}

process.title = "Kairos Kit dashboard";
const child = spawn(process.execPath, [next, mode, ...rest], {
  cwd: APP,
  env: { ...process.env, KAIROS_LOCAL_ONLY: "1" },
  stdio: "inherit",
});
// Ctrl-C reaches Next directly (same terminal); wait for it to end. A stop request is passed on.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", (err) => {
  console.error(`Could not start the dashboard: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
