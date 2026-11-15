import type { ApplicationReferrals, ContactView } from "@kairos/engine/contacts";
import Byline from "@/components/Byline";

/** People listed before the rest folds under "Show all". */
const SHOWN = 6;

function connected(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return `connected ${d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`;
}

function Person({ c, showCompany }: { c: ContactView; showCompany?: boolean }) {
  const detail = [c.position, showCompany ? c.company : null, connected(c.connected_on)].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 py-1 text-sm">
      {c.url ? (
        <a href={c.url} target="_blank" rel="noreferrer noopener" className="font-medium hover:underline" title="Open the LinkedIn profile in a new tab">
          {c.name} <span className="text-muted">↗</span>
        </a>
      ) : (
        <span className="font-medium">{c.name}</span>
      )}
      {detail && <span className="text-muted text-xs">{detail}</span>}
    </li>
  );
}

function People({ people, showCompany }: { people: ContactView[]; showCompany?: boolean }) {
  const first = people.slice(0, SHOWN);
  const rest = people.slice(SHOWN);
  return (
    <>
      <ul>
        {first.map((c, i) => (
          <Person key={i} c={c} showCompany={showCompany} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details>
          <summary className="text-muted cursor-pointer text-xs">Show all {people.length}</summary>
          <ul>
            {rest.map((c, i) => (
              <Person key={i} c={c} showCompany={showCompany} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * The people the user knows at the company of a well-matched application
 * (their LinkedIn connections, from the import). Shown only when there is
 * someone; Kairos suggests, the user writes to them.
 */
export default function Referrals({ referrals }: { referrals: ApplicationReferrals }) {
  const { contacts, related, company } = referrals;
  if (contacts.length + related.length === 0) return null;
  return (
    <section className="card mb-6 p-5">
      <h2 className="text-muted mb-1 text-xs font-medium uppercase tracking-wide">People you know at {company}<Byline name="Networker" /></h2>
      <p className="text-muted mb-2 text-xs">
        From your LinkedIn connections, by current company. A short conversation or a referral can help; you
        write to them, Kairos does not.
      </p>
      {contacts.length > 0 && <People people={contacts} />}
      {related.length > 0 && (
        <div className={contacts.length > 0 ? "mt-3" : undefined}>
          <div className="text-muted text-xs">
            Similar company name (a division of {company}, or a different company: check the profile)
          </div>
          <People people={related} showCompany />
        </div>
      )}
    </section>
  );
}
