/**
 * Hot-reload supervisor for the Kairos MCP server. Claude Code holds a stdio
 * pipe to THIS process, which never restarts; the real server.ts runs as a
 * child. When a watched source file changes, the child is restarted and the
 * cached MCP `initialize` handshake is replayed to the new child, so the
 * client's connection survives and the next tool call runs the new code.
 *
 * Restart policy: eager (debounced) while idle; deferred while a request is
 * in flight, then triggered by the next incoming request. Requests that are
 * unavoidably in flight at restart time get a JSON-RPC error telling the
 * caller to retry. After each reload the proxy emits
 * notifications/tools/list_changed so schema edits propagate too.
 *
 * MCP stdio framing is newline-delimited JSON, which is what makes the
 * replay/inspection here safe.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SERVER = path.join(HERE, "server.ts");
const WATCH_DIRS = [
  path.join(ROOT, "packages"),
  path.join(ROOT, "apps/local/lib"),
  path.join(ROOT, "apps/local/mcp"),
];
const SOURCE_RE = /\.(ts|tsx|mts|json)$/;
const DEBOUNCE_MS = 500;
const HANDSHAKE_TIMEOUT_MS = 20_000;

const log = (msg: string) => console.error(`[kairos-mcp-dev] ${msg}`);

// --- state -------------------------------------------------------------------

let child: ChildProcess | null = null;
let generation = 0;
let dirty = false;
let restarting = false;
/** Raw lines to replay on restart: the initialize request, then the initialized notification. */
const handshake: string[] = [];
let initializeId: string | number | null = null;
/** ids of client requests forwarded to the current child and not yet answered. */
const pending = new Set<string | number>();
/** Client lines that arrived mid-restart, to forward once the new child is up. */
const queue: string[] = [];

// --- child lifecycle ---------------------------------------------------------

let replayResolve: (() => void) | null = null;

function startChild(): void {
  const gen = ++generation;
  child = spawn("npx", ["tsx", SERVER], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  log(`server started (pid ${child.pid}, gen ${gen})`);

  let buf = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    if (gen !== generation) return; // stale child still flushing
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl + 1);
      buf = buf.slice(nl + 1);
      onChildLine(line);
    }
  });

  child.on("exit", (code) => {
    if (gen !== generation) return; // expected: we killed it for a reload
    // Unexpected death (crash, syntax error after an edit). Fail what's in
    // flight and lazily respawn on the next client message.
    log(`server exited unexpectedly (code ${code}); will respawn on next request`);
    child = null;
    dirty = true;
    failPending("kairos-mcp server crashed; retry the call (it respawns automatically)");
  });
}

function onChildLine(line: string): void {
  let id: string | number | undefined;
  try {
    id = JSON.parse(line).id;
  } catch {
    /* pass unparseable lines through untouched */
  }
  // Swallow the replayed-handshake response — the client already has one.
  if (restarting && replayResolve && id !== undefined && id === initializeId) {
    replayResolve();
    return;
  }
  if (id !== undefined) pending.delete(id);
  process.stdout.write(line);
}

function failPending(message: string): void {
  for (const id of pending) {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n",
    );
  }
  pending.clear();
}

async function restart(): Promise<void> {
  if (restarting) return;
  restarting = true;
  dirty = false;
  log("source change detected — reloading server");
  failPending("kairos-mcp reloaded after a source change; retry the tool call");

  if (child) {
    const old = child;
    child = null;
    generation++; // orphan the old child's listeners before killing it
    await new Promise<void>((resolve) => {
      old.once("exit", () => resolve());
      old.kill();
      setTimeout(() => {
        old.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    });
  }

  startChild();

  if (handshake.length > 0) {
    const replayed = new Promise<void>((resolve) => (replayResolve = resolve));
    child!.stdin!.write(handshake[0]); // initialize request
    const done = await Promise.race([
      replayed.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), HANDSHAKE_TIMEOUT_MS).unref()),
    ]);
    replayResolve = null;
    if (!done) log("handshake replay timed out — server may be broken; check stderr above");
    for (const line of handshake.slice(1)) child!.stdin!.write(line);
  }

  restarting = false;
  for (const line of queue.splice(0)) forwardToChild(line);
  // Nudge the client to re-list tools in case schemas/descriptions changed.
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n",
  );
  log("reload complete");
}

// --- client → child ----------------------------------------------------------

function forwardToChild(line: string): void {
  let msg: { id?: string | number; method?: string } = {};
  try {
    msg = JSON.parse(line);
  } catch {
    /* forward as-is */
  }
  if (msg.method === "initialize") {
    handshake[0] = line;
    initializeId = msg.id ?? null;
  } else if (msg.method === "notifications/initialized") {
    handshake[1] = line;
  }
  if (msg.id !== undefined && msg.method !== undefined) pending.add(msg.id);
  child?.stdin?.write(line);
}

function handleClientLine(line: string): void {
  if (restarting) {
    queue.push(line);
    return;
  }
  if (dirty || child === null) {
    queue.push(line);
    void restart();
    return;
  }
  forwardToChild(line);
}

// --- watcher -----------------------------------------------------------------

let debounce: NodeJS.Timeout | null = null;
const watchers: FSWatcher[] = [];
for (const dir of WATCH_DIRS) {
  try {
    watchers.push(
      watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename || !SOURCE_RE.test(filename)) return;
        if (filename.includes("node_modules") || filename.includes(".next")) return;
        dirty = true;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          // Eager restart only while idle; if a call is in flight, the next
          // incoming request triggers the reload instead.
          if (dirty && !restarting && pending.size === 0) void restart();
        }, DEBOUNCE_MS);
        debounce.unref();
      }),
    );
  } catch (e) {
    log(`watch failed for ${dir}: ${String(e)}`);
  }
}

// --- stdin pump --------------------------------------------------------------

let inBuf = "";
process.stdin.on("data", (chunk: Buffer) => {
  inBuf += chunk.toString("utf8");
  let nl;
  while ((nl = inBuf.indexOf("\n")) !== -1) {
    const line = inBuf.slice(0, nl + 1);
    inBuf = inBuf.slice(nl + 1);
    handleClientLine(line);
  }
});

process.stdin.on("end", () => {
  child?.kill();
  for (const w of watchers) w.close();
  process.exit(0);
});

startChild();
log(`watching: ${WATCH_DIRS.map((d) => path.relative(ROOT, d)).join(", ")}`);
