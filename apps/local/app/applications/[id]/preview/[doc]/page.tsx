import { notFound } from "next/navigation";
import { getApplication } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

/** Clean, print-friendly full-page view of a document — opened in a new tab. */
export default async function DocPreview({ params }: { params: Promise<{ id: string; doc: string }> }) {
  const { id, doc } = await params;
  const app = await getApplication(id);
  if (!app) notFound();
  const html = doc === "cover-letter" ? app.coverLetterHtml : app.resumeHtml;
  if (!html) notFound();
  const isResume = doc !== "cover-letter";

  return (
    <div style={{ background: "#e9e9ee", minHeight: "100vh", padding: "40px 16px" }}>
      <div
        className={`paper ${isResume ? "resume-doc" : ""}`}
        style={{ maxWidth: "816px", margin: "0 auto", padding: "56px 64px", boxShadow: "0 2px 20px rgba(0,0,0,.15)" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
