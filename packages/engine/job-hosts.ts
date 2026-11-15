/**
 * Sites that host job postings for many employers: applicant-tracking systems
 * and job boards. A link to one of them is a posting's address and nothing
 * else. Any other host can be anybody's, so where Kairos fetches a link on a
 * shared server it asks the user first (a fetched address can carry text in
 * its path or query to whoever runs the host).
 */
const KNOWN_JOB_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "myworkdayjobs.com",
  "myworkdaysite.com",
  "bamboohr.com",
  "smartrecruiters.com",
  "rippling.com",
  "workable.com",
  "icims.com",
  "jobvite.com",
  "recruitee.com",
  "teamtailor.com",
  "breezy.hr",
  "personio.com",
  "personio.de",
  "successfactors.com",
  "taleo.net",
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "wellfound.com",
  "welcometothejungle.com",
  "workatastartup.com",
  "builtin.com",
  "usajobs.gov",
];

/**
 * Hosts known by their shape, where the site's own name would cover too much. Oracle's recruiting pages are
 * on a customer's Fusion address (`<customer>.fa.<region>.oraclecloud.com`); `oraclecloud.com` as a whole is
 * every Oracle Cloud customer, file storage included, where anybody can serve a page.
 */
const KNOWN_JOB_HOST_PATTERNS = [/^[a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com$/];

/** The link's host name in lower case, or null when it is not an http(s) address. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** True when the link is on a known job site: the site itself or a name under it. */
export function isKnownJobHost(url: string): boolean {
  const host = hostOf(url);
  return host !== null && (KNOWN_JOB_HOSTS.some((known) => host === known || host.endsWith(`.${known}`)) || KNOWN_JOB_HOST_PATTERNS.some((p) => p.test(host)));
}
