import JSZip from "jszip";
import { zipEntryText } from "./zip-entry";

/**
 * LinkedIn delivers its data export as a .zip. Given the bytes of that
 * archive, return the text of the `Connections.csv` inside it. Bytes in, text
 * out: the caller reads the archive (a local file, an attachment, a Drive
 * file). Throws when the archive holds no connections file, or when
 * `maxBytes` is given and the connections file unpacks to more.
 */
export async function connectionsCsvFromZip(bytes: Uint8Array | ArrayBuffer, opts: { maxBytes?: number } = {}): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = Object.values(zip.files).find((f) => !f.dir && /(^|\/)connections\.csv$/i.test(f.name));
  if (!entry) {
    throw new Error(
      "This archive holds no Connections.csv. In LinkedIn: Settings, Data privacy, Get a copy of your data, and tick Connections.",
    );
  }
  if (opts.maxBytes === undefined) return entry.async("string");
  // With a limit (a server reading a file from elsewhere): unpacked piece by piece and stopped at the limit.
  return zipEntryText(entry, opts.maxBytes, TOO_LARGE);
}

const TOO_LARGE = "The Connections.csv in this archive is too large to read.";

/** A .zip starts with the bytes "PK". */
export const looksLikeZip = (bytes: Uint8Array): boolean => bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
