/**
 * An application's folder as a directory on disk, whatever the store.
 *
 * LibreOffice and poppler work on files, so the tools that render or measure
 * a résumé need a real directory. With the local store that is the
 * application's own folder, used in place. With any other store (the user's
 * Google Drive under the hosted connector) it is a temporary copy: the
 * documents are brought down, the work runs, and every Word or PDF file that
 * is new or changed is written back through the store. Nothing stays on the
 * server's disk afterwards.
 *
 * With such a store, a Word file is never brought down: the copy in the
 * user's storage can have been replaced by any file, and LibreOffice would
 * open it inside the server. The directory holds only the Word files the
 * caller hands over (`docx`), which the caller wrote itself from the saved
 * text. They are not written back: the store's copy was written when the
 * text was saved. PDF files are brought down, because they are only copied.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Store } from "@kairos/engine/store/types";
import { LocalStore } from "@/store/local-fs";

/** The data folder's path when the store is the local one, else null. */
export function localRoot(store: Store): string | null {
  return store instanceof LocalStore ? store.root : null;
}

const DOCUMENT = /\.(docx|pdf)$/i;
const MIME: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
};
const digest = (b: Buffer) => createHash("sha1").update(b).digest("hex");

/**
 * Run `work` with the application's folder as a directory. The directory
 * holds the application's Word and PDF files and its application-meta.json,
 * with profile.md two levels up (where the naming of submit-ready copies
 * looks for it).
 */
export async function withAppDir<T>(store: Store, appId: string, work: (dir: string) => Promise<T>, opts: { docx?: Record<string, Uint8Array> } = {}): Promise<T> {
  const root = localRoot(store);
  // On the user's own machine the folder is theirs, with their own files: used in place.
  if (root) return work(path.join(root, "applications", appId));

  const tmp = await mkdtemp(path.join(os.tmpdir(), "kairos-app-"));
  const dir = path.join(tmp, "applications", appId);
  try {
    await mkdir(dir, { recursive: true });
    const before = new Map<string, string>();
    const files = await store.listFiles(["applications", appId]);
    await Promise.all(
      files
        .filter((f) => /\.pdf$/i.test(f.name) || f.name === "application-meta.json")
        .map(async (f) => {
          const buf = await store.readBinary(["applications", appId, f.name]);
          if (!buf) return;
          await writeFile(path.join(dir, f.name), buf);
          before.set(f.name, digest(buf));
        }),
    );
    for (const [name, bytes] of Object.entries(opts.docx ?? {})) {
      if (!/^[a-z-]+\.docx$/.test(name)) continue;
      const buf = Buffer.from(bytes);
      await writeFile(path.join(dir, name), buf);
      before.set(name, digest(buf));
    }
    const profile = await store.readFile(["profile.md"]);
    if (profile) await writeFile(path.join(tmp, "profile.md"), profile);

    const result = await work(dir);

    for (const name of await readdir(dir)) {
      if (!DOCUMENT.test(name)) continue;
      const buf = await readFile(path.join(dir, name));
      if (before.get(name) === digest(buf)) continue;
      await store.writeBinary(["applications", appId, name], buf, MIME[path.extname(name).toLowerCase()]);
    }
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** How a tool names a file of an application to the user: the full path locally, the path inside the knowledge base elsewhere. */
export function appFilePath(store: Store, appId: string, name: string): string {
  const root = localRoot(store);
  return root ? path.join(root, "applications", appId, name) : `applications/${appId}/${name}`;
}
