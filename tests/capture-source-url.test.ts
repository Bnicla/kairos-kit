import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "@/store/local-fs";
import { createApplication, readMeta } from "@kairos/engine/applications";

/**
 * Card-creation invariant: every application must link back to its posting.
 * Regression guard for a real incident (2026-08-31): two paste-text captures
 * created cards with no source_url, so the board rendered them link-less.
 */

let store: LocalStore;
beforeEach(() => {
  store = new LocalStore(mkdtempSync(join(tmpdir(), "kairos-capture-")));
});

describe("createApplication source_url invariant", () => {
  it("refuses to create a card with no source_url and no explicit opt-out", async () => {
    await expect(
      createApplication(store, { company: "Acme", role: "PM", snapshotMarkdown: "ad" }),
    ).rejects.toThrow(/source_url/);
  });

  it("treats a whitespace-only source_url as missing", async () => {
    await expect(
      createApplication(store, { company: "Acme", role: "PM", snapshotMarkdown: "ad", source_url: "  " }),
    ).rejects.toThrow(/source_url/);
  });

  it("keeps the url on the card when provided (paste-capture path)", async () => {
    const meta = await createApplication(store, {
      company: "Acme",
      role: "PM",
      snapshotMarkdown: "ad",
      source_url: "https://boards.example.com/acme/pm-1",
    });
    const read = await readMeta(store, meta.id);
    expect(read?.source_url).toBe("https://boards.example.com/acme/pm-1");
  });

  it("allows an explicitly link-less card (emailed JD, fixtures)", async () => {
    const meta = await createApplication(store, {
      company: "Acme",
      role: "PM",
      snapshotMarkdown: "ad",
      source_url_unavailable: true,
    });
    expect((await readMeta(store, meta.id))?.source_url).toBeUndefined();
  });

  it("normalizes an empty-but-declared url to undefined rather than storing \"\"", async () => {
    const meta = await createApplication(store, {
      company: "Acme",
      role: "PM",
      snapshotMarkdown: "ad",
      source_url: "",
      source_url_unavailable: true,
    });
    expect((await readMeta(store, meta.id))?.source_url).toBeUndefined();
  });
});
