import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkSourcePath } from "../apps/local/lib/source-docs";

describe("prepare_extraction reads documents only", () => {
  const dir = mkdtempSync(join(tmpdir(), "kairos-src-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".ssh"));
  writeFileSync(join(dir, ".ssh", "notes.txt"), "secret");
  writeFileSync(join(dir, "resume.txt"), "x".repeat(200));
  writeFileSync(join(dir, "config.json"), "{}");
  symlinkSync(join(dir, ".ssh", "notes.txt"), join(dir, "cv.txt"));

  it("reads a résumé file", async () => {
    await expect(checkSourcePath(join(dir, "resume.txt"))).resolves.toMatchObject({ real: expect.stringContaining("resume.txt") });
  });
  it("refuses hidden folders, other file types, relative paths, and a link into a hidden folder", async () => {
    await expect(checkSourcePath(join(dir, ".ssh", "notes.txt"))).rejects.toThrow(/hidden/);
    await expect(checkSourcePath(join(dir, "config.json"))).rejects.toThrow(/PDF, DOCX/);
    await expect(checkSourcePath("resume.txt")).rejects.toThrow(/absolute/);
    await expect(checkSourcePath(join(dir, "cv.txt"))).rejects.toThrow(/hidden/);
    await expect(checkSourcePath(dir)).rejects.toThrow(/not a LinkedIn/);
  });
});
