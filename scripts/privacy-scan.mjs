#!/usr/bin/env node
// Personal-data scan for the Kairos Kit. Blocking: exits 1 on any hit.
//
// It always runs generic checks (real-looking email addresses, absolute home
// paths, phone numbers). Extra terms come from outside the repository, so the
// list itself is never published:
//   --patterns <file>        one term per line (see "Term syntax" below)
//   KIT_SCAN_PATTERNS        same format, e.g. from a CI secret
//
// Term syntax:
//   plain words     matched case-insensitively on word boundaries; spaces,
//                   hyphens and underscores between words are interchangeable
//   re:<regex>      a JavaScript regular expression, case-insensitive
//   exempt:<path>   the terms after this line are not checked in <path>
//                   (repeatable; a bare "exempt:" clears the list)
//   # comment       ignored
//
// Usage: node scripts/privacy-scan.mjs [--patterns file] [dir]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "out", "build", "coverage"]);
const MAX_BYTES = 5 * 1024 * 1024;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Turn the pattern-file text into named regexes. */
export function parsePatterns(text) {
  const out = [];
  let exempt = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("exempt:")) {
      const p = line.slice(7).trim();
      exempt = p ? [...exempt, p] : [];
      continue;
    }
    if (line.startsWith("re:")) {
      out.push({ label: line, re: new RegExp(line.slice(3), "gi"), exempt });
      continue;
    }
    const words = line.split(/[\s_-]+/).filter(Boolean).map(escape);
    if (!words.length) continue;
    const body = words.join("[\\s_-]?");
    out.push({ label: line, re: new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "gi"), exempt });
  }
  return out;
}

// Generic checks that need no private list.
const EMAIL_OK = /@(example\.(com|org|net|edu)|github\.com|users\.noreply\.github\.com|anthropic\.com|localhost|local|test|domain\.com|email\.com|x\.com|y\.com)$/i;
const PHONE_OK = /555[-. ]?01\d\d/;
export const GENERIC = [
  {
    label: "email address",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    ok: (m) => EMAIL_OK.test(m) || /^(noreply|no-reply|you|user|name|someone|student|jane|alex)@/i.test(m),
  },
  {
    label: "absolute home path",
    re: /\/(Users|home)\/[A-Za-z0-9._-]+/g,
    ok: (m) => /\/(Users|home)\/(you|user|username|runner|me|<[^>]*>|\$USER|name|alex|jane|student|example|shared|Shared)$/i.test(m),
  },
  {
    // Keys and tokens in their published formats: Anthropic, OpenAI, GitHub, AWS, Slack, Google, private keys.
    label: "key or token",
    re: /(sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g,
    ok: (m) => /(x{6,}|example|placeholder|0{8,}|\.\.\.)/i.test(m),
  },
  {
    label: "phone number",
    re: /(?<![\d.])(\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g,
    ok: (m) => PHONE_OK.test(m),
  },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile()) yield p;
  }
}

/** Scan a directory tree. Returns a list of hits; empty means clean. */
export function scan(root, patterns, { generic = true } = {}) {
  const checks = [...(generic ? GENERIC : []), ...patterns];
  const hits = [];
  for (const file of walk(root)) {
    const rel = relative(root, file);
    const active = checks.filter((c) => !c.exempt?.includes(rel));
    // File and folder names count too.
    for (const c of active) {
      c.re.lastIndex = 0;
      for (const m of rel.matchAll(c.re)) {
        if (!c.ok?.(m[0])) hits.push({ file: rel, line: 0, label: c.label, text: rel });
      }
    }
    const st = statSync(file);
    if (st.size > MAX_BYTES) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const c of active) {
        c.re.lastIndex = 0;
        for (const m of line.matchAll(c.re)) {
          if (c.ok?.(m[0])) continue;
          hits.push({ file: rel, line: i + 1, label: c.label, text: line.trim().slice(0, 160) });
        }
      }
    });
  }
  return hits;
}

export function report(hits, max = 200) {
  for (const h of hits.slice(0, max)) console.log(`  ${h.file}:${h.line}  [${h.label}]  ${h.text}`);
  if (hits.length > max) console.log(`  … and ${hits.length - max} more`);
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  let patternText = process.env.KIT_SCAN_PATTERNS || "";
  let root = ".";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--patterns") patternText += "\n" + readFileSync(args[++i], "utf8");
    else root = args[i];
  }
  const patterns = parsePatterns(patternText);
  const hits = scan(root, patterns);
  if (!patternText.trim()) console.log("privacy-scan: no private term list given (KIT_SCAN_PATTERNS); generic checks only.");
  if (hits.length) {
    console.log(`privacy-scan: FAILED, ${hits.length} hit(s):`);
    report(hits);
    process.exit(1);
  }
  console.log(`privacy-scan: clean (${patterns.length} private terms + generic checks).`);
}
