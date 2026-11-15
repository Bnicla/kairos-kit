import type { MessageState, ReferralMessage } from "@kairos/engine/referral-messages";
import { setReferralMessageStateAction } from "@/app/actions";
import CopyButton from "@/components/CopyButton";
import Byline from "@/components/Byline";

const STATE: Record<MessageState, { label: string; tone: string }> = {
  drafted: { label: "Draft, not sent", tone: "neutral" },
  sent: { label: "Sent by you", tone: "info" },
  answered: { label: "Answered", tone: "success" },
};

/** What the user can say happened next, from each state. */
const NEXT: Record<MessageState, { state: MessageState; label: string }[]> = {
  drafted: [{ state: "sent", label: "I sent it" }],
  sent: [
    { state: "answered", label: "They answered" },
    { state: "drafted", label: "Back to draft" },
  ],
  answered: [{ state: "sent", label: "Back to sent" }],
};

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

function Message({ appId, m }: { appId: string; m: ReferralMessage }) {
  const s = STATE[m.state] ?? STATE.drafted;
  const last = m.history[m.history.length - 1];
  return (
    <div className="border-t border-[var(--border)] pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm">
          <span className="text-muted">To </span>
          {m.contact.url ? (
            <a href={m.contact.url} target="_blank" rel="noreferrer noopener" className="font-medium hover:underline" title="Open the LinkedIn profile in a new tab">
              {m.contact.name} <span className="text-muted">↗</span>
            </a>
          ) : (
            <span className="font-medium">{m.contact.name}</span>
          )}
          {(m.contact.position || m.contact.company) && (
            <span className="text-muted text-xs"> · {[m.contact.position, m.contact.company].filter(Boolean).join(", ")}</span>
          )}
        </div>
        <span className={`badge badge-${s.tone} text-[10px]`} title={last?.note ? `${day(last.at)}: ${last.note}` : day(m.updated_at)}>
          {s.label}
        </span>
      </div>
      <pre className="bg-surface-2 mt-2 whitespace-pre-wrap rounded-md p-3 font-sans text-sm">{m.text}</pre>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <CopyButton text={m.text} label="Copy the message" />
        {NEXT[m.state].map((n) => (
          <form key={n.state} action={setReferralMessageStateAction}>
            <input type="hidden" name="appId" value={appId} />
            <input type="hidden" name="contact" value={m.contact.id} />
            <input type="hidden" name="state" value={n.state} />
            <button className="btn-secondary text-xs">{n.label}</button>
          </form>
        ))}
        <span className="text-muted text-xs">
          {m.text.split(/\s+/).filter(Boolean).length} words
          {m.relationship ? "" : " · claims no shared history"}
        </span>
      </div>
    </div>
  );
}

/**
 * The messages drafted for people the user knows at the company. Kairos
 * writes the draft; the user copies it, edits it and sends it on LinkedIn,
 * then says so here.
 */
export default function ReferralMessages({ appId, messages }: { appId: string; messages: ReferralMessage[] }) {
  if (!messages.length) return null;
  return (
    <section className="card mb-6 p-5">
      <h2 className="text-muted mb-1 text-xs font-medium uppercase tracking-wide">Messages to your contacts<Byline name="Networker" /></h2>
      <p className="text-muted mb-3 text-xs">
        Drafts only. Copy a message, edit it, and send it yourself on LinkedIn; Kairos sends nothing. The state changes when you say so.
      </p>
      <div className="space-y-3">
        {messages.map((m) => (
          <Message key={m.contact.id} appId={appId} m={m} />
        ))}
      </div>
    </section>
  );
}
