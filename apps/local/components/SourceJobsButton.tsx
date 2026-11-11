"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { sourceJobsAction, type SourceJobsResult } from "@/app/actions";

function Inner() {
  const { pending } = useFormStatus();
  return (
    <button
      className="btn-secondary whitespace-nowrap !py-1.5 text-sm disabled:opacity-60"
      disabled={pending}
      title="Sweep 6,000+ company job boards for roles posted this week, triage them, and fill the Sourced column"
    >
      {pending ? "Sourcing…" : "⌁ Source jobs"}
    </button>
  );
}

export default function SourceJobsButton() {
  const [result, action] = useActionState<SourceJobsResult, FormData>(sourceJobsAction, null);
  return (
    <form action={action} className="flex items-center gap-2">
      <Inner />
      {result && !result.ok ? (
        <span role="alert" className="max-w-md text-xs text-[var(--danger-fg)]">
          {result.message}
        </span>
      ) : null}
    </form>
  );
}
