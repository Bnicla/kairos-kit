import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalStore, kairosHome, HOME_POINTER } from "../apps/local/store/local-fs";

/**
 * A data folder on a Windows PC: files a Windows editor saved end their lines
 * with \r\n, and paths are written with backslashes.
 */
describe("files and paths written on Windows", () => {
  const root = mkdtempSync(join(tmpdir(), "kairos-crlf-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a file saved with Windows line endings is read with plain ones", async () => {
    writeFileSync(join(root, "profile.md"), "---\r\nname: Dana Okafor\r\n---\r\n\r\nNotes.\r\n");
    const text = await new LocalStore(root).readFile(["profile.md"]);
    expect(text).toBe("---\nname: Dana Okafor\n---\n\nNotes.\n");
  });

  it("the data folder's pointer may be written with Windows line endings", () => {
    const prev = process.env.KAIROS_HOME;
    delete process.env.KAIROS_HOME;
    try {
      writeFileSync(join(root, HOME_POINTER), "C:\\Users\\dana\\Kairos\r\n");
      expect(kairosHome(root)).toBe("C:\\Users\\dana\\Kairos");
    } finally {
      if (prev !== undefined) process.env.KAIROS_HOME = prev;
    }
  });
});
