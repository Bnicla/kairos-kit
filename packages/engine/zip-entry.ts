import type JSZip from "jszip";

/**
 * The text of one file of a .zip archive, unpacked piece by piece and stopped
 * at a limit. For a server that reads an archive from elsewhere: a small
 * archive can unpack to far more than its size, and the size it states for a
 * file can be false. Rejects with `tooLarge` when the file states more than
 * `maxBytes` or unpacks to more.
 */
export function zipEntryText(entry: JSZip.JSZipObject, maxBytes: number, tooLarge: string): Promise<string> {
  const stated = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof stated === "number" && stated > maxBytes) return Promise.reject(new Error(tooLarge));
  return new Promise((resolve, reject) => {
    const pieces: Uint8Array[] = [];
    let size = 0;
    let over = false;
    // JSZip's own stream of an entry; its type declarations leave the method out.
    const stream = (entry as unknown as { internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream("uint8array");
    stream
      .on("data", (piece: Uint8Array) => {
        if (over) return;
        size += piece.length;
        if (size > maxBytes) {
          over = true;
          stream.pause();
          reject(new Error(tooLarge));
          return;
        }
        pieces.push(piece);
      })
      .on("error", (e: Error) => {
        if (!over) reject(e);
      })
      .on("end", () => {
        if (over) return;
        const all = new Uint8Array(size);
        let at = 0;
        for (const p of pieces) {
          all.set(p, at);
          at += p.length;
        }
        resolve(new TextDecoder().decode(all));
      })
      .resume();
  });
}
