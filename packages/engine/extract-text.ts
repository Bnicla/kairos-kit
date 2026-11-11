import JSZip from "jszip";

/**
 * Server-side résumé text extraction for onboarding. PDF via unpdf (pure JS,
 * runs on Vercel), DOCX via jszip (document.xml text runs), plain text as-is.
 */
export async function extractResumeText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  if (name.endsWith(".pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim();
  }

  if (name.endsWith(".docx")) {
    const zip = await JSZip.loadAsync(buffer);
    const doc = zip.file("word/document.xml");
    if (!doc) throw new Error("That .docx has no readable content.");
    const xml = await doc.async("string");
    return xml
      .replace(/<w:p[ >]/g, "\n<w:p ")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  if (name.endsWith(".txt") || name.endsWith(".md")) {
    return buffer.toString("utf8").trim();
  }

  throw new Error("Unsupported file type. Upload a PDF, DOCX, or plain-text file.");
}
