"use client";

export default function PrintButton({ label = "Print / export PDF" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="btn-secondary print-hide text-xs"
      title="Open the browser print dialog — choose 'Save as PDF' to export"
    >
      {label}
    </button>
  );
}
