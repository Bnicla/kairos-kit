/**
 * Shown when a page's source file does not exist yet (a new user). Says what
 * the page is for, which file feeds it, and what to ask Kairos to fill it.
 */
export default function EmptyState({ title, file, ask }: { title: string; file: string; ask: string }) {
  return (
    <div className="card mt-4 p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-muted mt-1 text-sm">
        Nothing here yet. This page reads <code>{file}</code> in your Kairos data folder.
      </p>
      <p className="text-muted mt-1 text-sm">{ask}</p>
    </div>
  );
}
