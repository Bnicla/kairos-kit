"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { HealthReport } from "@kairos/engine/health";

/**
 * Health Lab: visualize the stage-aware grading. Load the live KB, the student
 * fixture, or drop any experience .md files, and see the same KB graded on
 * every curve side by side. Dev tool for tuning thresholds and fix texts.
 */

interface LabResult {
  entries: { fileName: string; company: string; title: string; dates: string }[];
  derivedStage: "early" | "mid" | "senior";
  derived: HealthReport;
  early: HealthReport;
  mid: HealthReport;
  senior: HealthReport;
  parseInfo?: { fileName: string; bullets: number; span: string; headline: string | null };
  error?: string;
}

const STAGE_LABEL = { early: "Early career", mid: "Mid career", senior: "Senior" } as const;

function scoreTone(score: number) {
  return score >= 4 ? "badge-success" : score >= 2.5 ? "badge-info" : "badge-warn";
}

export default function HealthLab() {
  const [result, setResult] = useState<LabResult | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load(source: "live" | "fixture") {
    setLoading(source);
    setError(null);
    try {
      const res = await fetch(`/api/health-lab?source=${source}`);
      const data = (await res.json()) as LabResult;
      if (!res.ok || data.error) setError(data.error ?? "Failed to load.");
      else setResult(data);
    } catch {
      setError("Failed to load.");
    } finally {
      setLoading(null);
    }
  }

  async function loadFiles(files: FileList) {
    setLoading("upload");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", files[0]);
      const res = await fetch("/api/health-lab", { method: "POST", body: form });
      const data = (await res.json()) as LabResult;
      if (!res.ok || data.error) setError(data.error ?? "Failed to grade.");
      else setResult(data);
    } catch {
      setError("Failed to grade that file.");
    } finally {
      setLoading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const curves: ("early" | "mid" | "senior")[] = ["early", "mid", "senior"];
  const GROUPS = ["Mechanics", "Content", "Authenticity", "Depth"] as const;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6">
        <Link href="/" className="text-muted text-xs hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Health Lab</h1>
        <p className="text-muted text-sm">
          The same knowledge base graded on every curve. Highlighted column = the curve the stage
          derivation would actually pick.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button className="btn-primary text-sm" onClick={() => fileRef.current?.click()} disabled={loading !== null}>
          {loading === "upload" ? "Grading…" : "Grade a résumé (PDF/Word/text)"}
        </button>
        <button className="btn-secondary text-sm" onClick={() => load("live")} disabled={loading !== null}>
          {loading === "live" ? "Loading…" : "My live KB"}
        </button>
        <button className="btn-secondary text-sm" onClick={() => load("fixture")} disabled={loading !== null}>
          {loading === "fixture" ? "Loading…" : "Student fixture"}
        </button>
        {result && (
          <button
            className="btn-secondary text-sm"
            onClick={() => {
              setResult(null);
              setError(null);
            }}
          >
            Start over
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          hidden
          onChange={(e) => e.target.files?.length && loadFiles(e.target.files)}
        />
      </div>

      {!result && !error && (
        <div className="card p-5">
          <p className="text-muted text-sm">
            A blank bench each time. Grade a résumé file directly, or load a knowledge base, and
            the full report renders below: every category, every dimension, evidence, and the
            flagged bullets, across all three grading curves.
          </p>
        </div>
      )}

      {error && <div className="card mb-6 border-[var(--danger-fg)] p-4 text-sm">⚠ {error}</div>}

      {result && (
        <>
          <section className="card mb-6 p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="badge badge-info">derived: {STAGE_LABEL[result.derivedStage]}</span>
              {result.parseInfo ? (
                <>
                  <span className="badge badge-neutral">📄 {result.parseInfo.fileName}</span>
                  <span className="badge badge-neutral">{result.parseInfo.bullets} bullets detected</span>
                  <span className="badge badge-neutral">span {result.parseInfo.span}</span>
                  {result.parseInfo.headline && (
                    <span className="badge badge-neutral">headline: {result.parseInfo.headline}</span>
                  )}
                </>
              ) : (
                result.entries.map((e) => (
                  <span key={e.fileName} className="badge badge-neutral" title={e.fileName}>
                    {e.company} · {e.dates}
                  </span>
                ))
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {curves.map((c) => (
                <div
                  key={c}
                  className={`rounded-lg border p-4 text-center ${
                    c === result.derivedStage
                      ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                      : "border-[var(--border)]"
                  }`}
                >
                  <div className="text-muted text-xs uppercase tracking-wide">{STAGE_LABEL[c]} curve</div>
                  <div className="mt-1 text-3xl font-semibold tabular-nums">{result[c].overall}</div>
                  <div className="text-muted mt-1 text-xs">{result[c].verdict}</div>
                </div>
              ))}
            </div>
          </section>

          {GROUPS.map((group) => {
            const dims = result.derived.dimensions
              .map((d, i) => ({ ...d, idx: i }))
              .filter((d) => d.group === group);
            if (!dims.length) return null;
            return (
              <section key={group} className="card mb-6 p-5">
                <h2 className="text-muted mb-3 text-xs font-medium uppercase tracking-wide">{group}</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted text-left text-xs">
                      <th className="pb-2 font-medium">Dimension</th>
                      {curves.map((c) => (
                        <th
                          key={c}
                          className={`w-20 px-2 pb-2 text-center font-medium ${c === result.derivedStage ? "text-[var(--accent)]" : ""}`}
                        >
                          {STAGE_LABEL[c]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dims.map((dim) => (
                      <tr key={dim.key} className="border-t border-[var(--border)] align-top">
                        <td className="py-2 pr-3">
                          <div className="font-medium">{dim.label}</div>
                          <div className="text-muted text-xs">{dim.detail}</div>
                          {dim.evidence && (
                            <div className="text-muted mt-0.5 text-xs">
                              evidence: {dim.evidence.length > 160 ? `${dim.evidence.slice(0, 160)}…` : dim.evidence}
                            </div>
                          )}
                          {dim.fix && <div className="text-muted mt-0.5 text-xs italic">fix: {dim.fix}</div>}
                        </td>
                        {curves.map((c) => {
                          const d = result[c].dimensions[dim.idx];
                          return (
                            <td key={c} className="py-2 text-center">
                              <span
                                className={`badge ${scoreTone(d.score)} ${c === result.derivedStage ? "" : "opacity-60"}`}
                              >
                                {d.score}/5
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}

          {result.derived.flaggedBullets.length > 0 && (
            <section className="card mb-6 p-5">
              <h2 className="text-muted mb-3 text-xs font-medium uppercase tracking-wide">
                Flagged bullets ({result.derived.flaggedBullets.length})
              </h2>
              <div className="space-y-2">
                {result.derived.flaggedBullets.map((b, i) => (
                  <div key={i} className="rounded-lg border border-[var(--border)] p-3 text-sm">
                    <div>{b.bullet}</div>
                    <div className="text-muted mt-1 text-xs">
                      {b.experience} · {b.why}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <p className="text-muted mb-6 text-center text-xs">
            {result.derived.counts.experiences} entries · {result.derived.counts.bullets} bullets ·{" "}
            {result.derived.counts.quantified} quantified · {result.derived.counts.confirmed} confirmed facts
          </p>

          {result.derived.topFixes.length > 0 && (
            <section className="card p-5">
              <h2 className="text-muted mb-2 text-xs font-medium uppercase tracking-wide">
                Top fixes (derived curve)
              </h2>
              <ol className="text-muted list-decimal space-y-1 pl-5 text-sm">
                {result.derived.topFixes.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}
