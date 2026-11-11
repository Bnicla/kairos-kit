/**
 * Storage abstraction. The engine (kb store, applications) talks only to this
 * interface, so the same logic runs over local files (personal lane) or Google
 * Drive (future student lane) by swapping the adapter.
 *
 * Paths are arrays of segments relative to the Kairos root, e.g.
 * ["knowledge-base", "experiences", "01-acme-pm.md"].
 */

export interface FileEntry {
  /** Adapter-specific handle. For local storage this is the file name. */
  id: string;
  name: string;
  mimeType: string;
}

export interface FolderEntry {
  id: string;
  name: string;
}

export interface Store {
  /** File names (not folders) directly under a folder path. [] if missing. */
  listFiles(folderPath: string[]): Promise<FileEntry[]>;
  /** Sub-folder names under a folder path. [] if missing. */
  listFolders(folderPath: string[]): Promise<FolderEntry[]>;
  /** Read a text file. null if it does not exist. */
  readFile(filePath: string[]): Promise<string | null>;
  /** Read a binary file (e.g. a .docx) as a Buffer. null if it does not exist. */
  readBinary(filePath: string[]): Promise<Buffer | null>;
  /** Create/overwrite a text file (parent folders auto-created). Returns a handle. */
  writeFile(filePath: string[], content: string, mimeType?: string): Promise<string>;
  /** Write binary content (e.g. a rendered PDF). Returns a handle. */
  writeBinary(filePath: string[], buffer: Buffer, mimeType?: string): Promise<string>;
  /** Read + JSON.parse a file. null if missing or unparseable. */
  readJson<T>(filePath: string[]): Promise<T | null>;
  /** JSON.stringify + write. Returns a handle. */
  writeJson(filePath: string[], data: unknown): Promise<string>;
}
