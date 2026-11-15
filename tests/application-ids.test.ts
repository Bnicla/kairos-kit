import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalStore } from "@/store/local-fs";
import { applicationFolderName, createApplication, idPart, loadIndex, readMeta, slugify, updateMeta } from "@kairos/engine/applications";

/**
 * An application's id is the day, the company and the role. Invented names.
 * No part is ever empty, two different names do not become one id, and one
 * application never takes another's folder.
 */
describe("application ids", () => {
  const home = mkdtempSync(join(tmpdir(), "kairos-app-ids-"));
  const store = new LocalStore(home);
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const day = "2026-11-15";
  const ad = (text: string) => `# A posting\n${text}`;

  it("a name in Latin letters gives the id it always gave", () => {
    expect(idPart("Brightwater Systems")).toBe("brightwater-systems");
    expect(idPart("Société Générale")).toBe("societe-generale");
    expect(idPart("Senior Product Manager, AI (Remote)")).toBe("senior-product-manager-ai-remote");
    expect(applicationFolderName("Acme", "Staff PM", "2026-07-06")).toBe("2026-07-06_acme_staff-pm");
    for (const name of ["Brightwater Systems", "Müller & Söhne GmbH", "R&D Engineer II", "A".repeat(60)]) expect(idPart(name), name).toBe(slugify(name));
  });

  it("a name in another script is never an empty part, and two such names differ", () => {
    const names = ["株式会社", "工程師", "Яндекс", "شركة", "한국전력", "トヨタ"];
    const parts = names.map(idPart);
    for (const [i, part] of parts.entries()) {
      expect(slugify(names[i])).toBe("");
      expect(part, names[i]).toMatch(/^[a-z0-9]{7}$/);
    }
    expect(new Set(parts).size).toBe(names.length);
    // The same name gives the same part, each time.
    expect(idPart("株式会社")).toBe(idPart("株式会社"));
    // Part Latin, part not: the Latin part stays readable, and the rest still counts.
    expect(idPart("Toyota トヨタ")).toMatch(/^toyota-[a-z0-9]{7}$/);
    expect(idPart("Toyota トヨタ")).not.toBe(idPart("Toyota 豊田"));
    expect(applicationFolderName("株式会社", "工程師", day)).toMatch(/^2026-11-15_[a-z0-9]{7}_[a-z0-9]{7}$/);
  });

  it("two long names that are the same for their first 60 characters do not share a part", () => {
    const stem = "Senior Principal Product Manager, Machine Learning Platform and Infrastructure";
    const a = `${stem}, Payments`;
    const b = `${stem}, Search`;
    expect(slugify(a)).toBe(slugify(b));
    expect(idPart(a)).not.toBe(idPart(b));
    expect(idPart(a).length).toBeLessThanOrEqual(60);
    expect(idPart(a)).toMatch(/^senior-principal-product-manager-machine-learning-pl-[a-z0-9]{7}$/);
  });

  it("two applications in another script are two folders, each with its own posting", async () => {
    const one = await createApplication(store, { company: "株式会社", role: "工程師", snapshotMarkdown: ad("first"), source_url: "https://jobs.example/1" });
    const two = await createApplication(store, { company: "有限会社", role: "設計師", snapshotMarkdown: ad("second"), source_url: "https://jobs.example/2" });
    expect(one.id).not.toBe(two.id);
    expect(await store.readFile(["applications", one.id, "job-ad-snapshot.md"])).toContain("first");
    expect(await store.readFile(["applications", two.id, "job-ad-snapshot.md"])).toContain("second");
  });

  it("a second posting with the same company and role on the same day gets an id of its own; the first is not touched", async () => {
    const first = await createApplication(store, { company: "Brightwater Systems", role: "Software Engineer", snapshotMarkdown: ad("the Seattle posting"), source_url: "https://jobs.example/seattle" });
    await updateMeta(store, first.id, { status: "applied" });
    const second = await createApplication(store, { company: "Brightwater Systems", role: "Software Engineer", snapshotMarkdown: ad("the Denver posting"), source_url: "https://jobs.example/denver" });
    const third = await createApplication(store, { company: "Brightwater Systems", role: "Software Engineer", snapshotMarkdown: ad("the Austin posting"), source_url: "https://jobs.example/austin" });
    expect(second.id).toBe(`${first.id}-2`);
    expect(third.id).toBe(`${first.id}-3`);
    // The first keeps its posting and its status.
    expect(await store.readFile(["applications", first.id, "job-ad-snapshot.md"])).toContain("the Seattle posting");
    expect((await readMeta(store, first.id))?.status).toBe("applied");
    expect(await store.readFile(["applications", second.id, "job-ad-snapshot.md"])).toContain("the Denver posting");
    const ids = (await loadIndex(store)).applications.map((a) => a.id);
    for (const id of [first.id, second.id, third.id]) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the same posting captured again (same company, role and link) keeps its id, as before", async () => {
    const before = readdirSync(join(home, "applications")).length;
    const again = await createApplication(store, { company: "Brightwater Systems", role: "Software Engineer", snapshotMarkdown: ad("the Denver posting, read again"), source_url: "https://jobs.example/denver" });
    expect(again.id).toMatch(/_brightwater-systems_software-engineer-2$/);
    expect(readdirSync(join(home, "applications")).length).toBe(before);
  });

  it("an id made before this rule still opens", async () => {
    // A folder as an earlier version named it: a long role cut at 60 characters, with no code after it.
    const old = `2026-10-01_acme_${slugify("Senior Principal Product Manager, Machine Learning Platform and Infrastructure, Payments")}`;
    await store.writeJson(["applications", old, "application-meta.json"], { id: old, company: "Acme", role: "A role", status: "scored", captured_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" });
    expect((await readMeta(store, old))?.status).toBe("scored");
    const moved = await updateMeta(store, old, { status: "applied" });
    expect(moved.id).toBe(old);
  });
});
