import { describe, it, expect } from "vitest";
import type { FileEntry, FolderEntry, Store } from "@kairos/engine/store/types";
import { createApplication, loadIndex, loadIndexHealed } from "@kairos/engine/applications";

/** Minimal in-memory Store with folder semantics for the applications tree. */
class MemStore implements Store {
  files = new Map<string, string>();
  private key(p: string[]) {
    return p.join("/");
  }
  async listFiles(folderPath: string[]): Promise<FileEntry[]> {
    const prefix = this.key(folderPath) + "/";
    const out: FileEntry[] = [];
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) {
        out.push({ id: k, name: k.slice(prefix.length), mimeType: "text/markdown" });
      }
    }
    return out;
  }
  async listFolders(folderPath: string[]): Promise<FolderEntry[]> {
    const prefix = folderPath.length ? this.key(folderPath) + "/" : "";
    const names = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash !== -1) names.add(rest.slice(0, slash));
    }
    return [...names].map((name) => ({ id: prefix + name, name }));
  }
  async readFile(p: string[]) {
    return this.files.get(this.key(p)) ?? null;
  }
  async readBinary() {
    return null;
  }
  async writeFile(p: string[], content: string) {
    this.files.set(this.key(p), content);
    return this.key(p);
  }
  async writeBinary(p: string[]) {
    return this.key(p);
  }
  async readJson<T>(p: string[]): Promise<T | null> {
    const raw = await this.readFile(p);
    return raw === null ? null : (JSON.parse(raw) as T);
  }
  async writeJson(p: string[], data: unknown) {
    return this.writeFile(p, JSON.stringify(data));
  }
}

const INDEX = ["_index.json"];

describe("applications index self-heal", () => {
  it("rebuilds dropped entries from the folder metas", async () => {
    const store = new MemStore();
    const a = await createApplication(store, { company: "Acme", role: "PM", snapshotMarkdown: "ad A" , source_url_unavailable: true });
    const b = await createApplication(store, { company: "Beta", role: "Lead", snapshotMarkdown: "ad B" , source_url_unavailable: true });

    // Simulate a cross-process clobber: the index loses one entry.
    const idx = await store.readJson<{ version: 1; applications: { id: string }[] }>(INDEX);
    idx!.applications = idx!.applications.slice(0, 1);
    await store.writeJson(INDEX, idx);

    const healed = await loadIndexHealed(store);
    expect(healed.applications.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());

    // And the healed index was persisted.
    const persisted = await store.readJson<{ applications: unknown[] }>(INDEX);
    expect(persisted!.applications).toHaveLength(2);
  });

  it("leaves a consistent index untouched", async () => {
    const store = new MemStore();
    await createApplication(store, { company: "Acme", role: "PM", snapshotMarkdown: "ad A" , source_url_unavailable: true });
    const idx = await loadIndexHealed(store);
    expect(idx.applications).toHaveLength(1);
  });

  it("never shrinks the index on a stale (shorter) folder listing", async () => {
    const store = new MemStore();
    await createApplication(store, { company: "Acme", role: "PM", snapshotMarkdown: "ad A" , source_url_unavailable: true });
    await createApplication(store, { company: "Beta", role: "Lead", snapshotMarkdown: "ad B" , source_url_unavailable: true });

    // Simulate a stale cached folder listing that misses the newest folder.
    const realListFolders = store.listFolders.bind(store);
    store.listFolders = async (p: string[]) => (await realListFolders(p)).slice(0, 1);

    const idx = await loadIndexHealed(store);
    expect(idx.applications).toHaveLength(2);

    // Plain loadIndex never touches folders at all.
    const plain = await loadIndex(store);
    expect(plain.applications).toHaveLength(2);
  });
});
