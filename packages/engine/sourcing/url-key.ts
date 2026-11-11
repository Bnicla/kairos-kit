/**
 * The one identity key for a posting URL, shared by the filter's seen check,
 * the backlog, the seen-ledger and the sweep's live set.
 *
 * Query strings are dropped. Workday and SmartRecruiters URLs are also folded
 * to lower case, because those ATSes ignore case in the parts that vary: the
 * Workday site name ("Acme_Careers_External" = "acme_careers_external") and the
 * SmartRecruiters company id. Found 2026-11-06: a run on the committed seed
 * registry (lowercase site names) produced lowercase Workday URLs while the
 * ledger held the harvested spelling, so the same open postings were reported
 * as vanished and could slip past the applied/dismissed check. Other ATSes keep
 * their exact path (Greenhouse, Lever and Ashby ids are case-sensitive).
 */
export function postingKey(url: string): string {
  const base = url.split("?")[0].split("#")[0];
  return /myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com/i.test(base) ? base.toLowerCase() : base;
}
