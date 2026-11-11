import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrepNote } from "@/lib/dashboard";
import PrintButton from "@/components/PrintButton";

export const dynamic = "force-dynamic";

// A prep note (brief, reconstruction, review) from the application folder, rendered from its markdown.
export default async function PrepNotePage({ params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const note = await getPrepNote(id, decodeURIComponent(file));
  if (!note) notFound();

  return (
    <div className="print-page mx-auto max-w-4xl px-6 py-8">
      <div className="print-hide mb-4 flex items-start justify-between gap-4">
        <div>
          <Link href={`/applications/${id}`} className="text-muted text-xs hover:underline">
            ← {note.meta.company}: {note.meta.role}
          </Link>
          <p className="text-muted mt-1 text-xs">
            {decodeURIComponent(file)} ·{" "}
            <span className="prov prov-c">C</span> confirmed{" "}
            <span className="prov prov-q">?</span> assumption, not to say{" "}
            <span className="prov prov-k">K</span> how it works{" "}
            <span className="prov prov-rev">rev</span> revised after review
          </p>
        </div>
        <PrintButton />
      </div>
      <article className="note-doc" dangerouslySetInnerHTML={{ __html: note.html }} />
    </div>
  );
}
