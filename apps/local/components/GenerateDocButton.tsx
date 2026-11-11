"use client";

import { useFormStatus } from "react-dom";

/** Submit button for one-click document generation (headless Claude, minutes). */
export default function GenerateDocButton({ kind }: { kind: "resume" | "cover-letter" }) {
  const { pending } = useFormStatus();
  return (
    <button
      className="btn-secondary text-sm disabled:opacity-60"
      disabled={pending}
      title="Generates through the anti-fabrication and house-style gates on your Max plan (takes a few minutes)"
    >
      {pending ? (kind === "resume" ? "Generating…" : "Writing…") : "✎ Generate"}
    </button>
  );
}
