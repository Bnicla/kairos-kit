import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import matter, { FrontMatterLanguageError } from "../packages/engine/front-matter";

/**
 * Front matter is data, never code. The parsing library runs a block marked
 * as JavaScript; the one helper every reader uses refuses it.
 */
describe("front matter", () => {
  it("reads YAML and JSON, and writes YAML", () => {
    const yaml = matter("---\ncompany: Ledgerly\nskills: [Python, SQL]\n---\n\nBody text\n");
    expect(yaml.data).toEqual({ company: "Ledgerly", skills: ["Python", "SQL"] });
    expect(yaml.content.trim()).toBe("Body text");
    expect(matter('---json\n{ "company": "Ledgerly" }\n---\nBody').data).toEqual({ company: "Ledgerly" });
    expect(matter("No front matter at all").data).toEqual({});
    const written = matter.stringify("\nBody\n", { company: "Ledgerly", year: 2025 });
    expect(matter(written).data).toEqual({ company: "Ledgerly", year: 2025 });
  });

  it("refuses a block marked as JavaScript, however the mark is written, and runs none of it", () => {
    const marks = ["---js", "---javascript", "--- js", "---JS", "---JavaScript", "--- javascript ", "---Js"];
    for (const mark of marks) {
      (globalThis as { frontMatterProbe?: number }).frontMatterProbe = 0;
      const file = `${mark}\n{ probe: (globalThis.frontMatterProbe = 20 + 22), node: typeof process }\n---\nBody\n`;
      expect(() => matter(file), mark).toThrow(FrontMatterLanguageError);
      expect((globalThis as { frontMatterProbe?: number }).frontMatterProbe, mark).toBe(0);
    }
    delete (globalThis as { frontMatterProbe?: number }).frontMatterProbe;
    // The same holds a second time for the same text: nothing is kept from a first parse.
    expect(() => matter("---js\n{ a: 1 }\n---\n")).toThrow(FrontMatterLanguageError);
    expect(() => matter("---js\n{ a: 1 }\n---\n")).toThrow(FrontMatterLanguageError);
  });

  it("a YAML block cannot build a JavaScript value", () => {
    expect(() => matter("---\nrun: !!js/function 'function () { return 1 }'\n---\n")).toThrow();
    expect(() => matter("---\nrun: !!js/regexp /a+/\n---\n")).toThrow();
  });

  it("no other file reads front matter with the library directly", () => {
    const roots = ["apps", "packages", "scripts", "evals"];
    const skip = new Set(["node_modules", ".next", "dist", "build", ".turbo"]);
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) sources.push(path);
      }
    };
    for (const root of roots) {
      try {
        walk(root);
      } catch {
        // a root that this copy of the repository does not have (the Kit ships fewer)
      }
    }
    expect(sources.length).toBeGreaterThan(50);
    const direct = sources.filter((path) => path !== join("packages", "engine", "front-matter.ts") && /["']gray-matter["']/.test(readFileSync(path, "utf8")));
    expect(direct, "import front matter from packages/engine/front-matter instead").toEqual([]);
  });
});
