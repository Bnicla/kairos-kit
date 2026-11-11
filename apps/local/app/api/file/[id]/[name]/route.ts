import matter from "gray-matter";
import { getStore } from "@/store";
import { submissionFileName } from "@kairos/engine/file-names";

/**
 * Download a document from an application folder. Whitelisted filenames only —
 * never an arbitrary path — so the dashboard can serve the generated resume,
 * cover letter, or the actually-submitted file for download.
 */
const ALLOWED = /^(resume\.docx|resume\.pdf|cover-letter\.docx|cover-letter\.pdf|submitted-resume\.[a-z0-9]+)$/;

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  if (!ALLOWED.test(name)) return new Response("Not found", { status: 404 });

  const buf = await getStore().readBinary(["applications", id, name]);
  if (!buf) return new Response("Not found", { status: 404 });

  const ext = name.split(".").pop() ?? "";
  // Same name as the submit-ready copy in the folder (engine/file-names).
  const store = getStore();
  const meta = (await store.readJson<{ company?: string }>(["applications", id, "application-meta.json"])) ?? {};
  const profile = await store.readFile(["profile.md"]);
  const candidate = profile ? (matter(profile).data as { name?: string }).name : undefined;
  const doc = name.startsWith("cover-letter") ? "cover-letter" : "resume";
  const downloadName = /^(resume|cover-letter)\.(pdf|docx)$/.test(name)
    ? submissionFileName(candidate, meta.company, doc, ext as "pdf" | "docx")
    : `${submissionFileName(candidate, meta.company, "resume", "pdf").replace(/-resume\.pdf$/, "")}-${name}`;

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${downloadName}"`,
      "Content-Length": String(buf.length),
    },
  });
}
