import { LocalStore, kairosHome } from "@/store/local-fs";
import type { Store } from "@kairos/engine/store/types";

/**
 * Default Store for the personal lane: local filesystem under ~/Kairos/.
 * The v2 student lane will swap in a DriveStore adapter behind the same interface.
 */

let cached: LocalStore | null = null;

export function getStore(): LocalStore {
  if (!cached) cached = new LocalStore();
  return cached;
}

export { LocalStore, kairosHome };
export type { Store, FileEntry, FolderEntry } from "@kairos/engine/store/types";
