/**
 * Fixture job ads with band-level expectations for the student-persona KB
 * (tests/fixtures/student-kb: a new-grad SWE with one fintech internship and a
 * capstone project). Expectations are deliberately band-level ranges, not point
 * asserts — the scorer's honesty contract is bands, and evals should measure
 * the contract, not overfit to one model's phrasing.
 */

export interface AdFixture {
  id: string;
  title: string;
  jobText: string;
  expect: {
    /** Acceptable overall_band values. */
    bands: string[];
    /** Recommendations that MUST NOT appear (e.g. a weak fit may never be APPLY). */
    forbidRecommendations?: string[];
    /** Recommendations that MUST appear (use sparingly). */
    requireRecommendations?: string[];
  };
}

export const AD_FIXTURES: AdFixture[] = [
  {
    id: "junior-swe-fintech",
    title: "Software Engineer I — fintech (good fit)",
    expect: { bands: ["STRONG", "COMPETITIVE"], forbidRecommendations: ["NOT_RECOMMENDED"] },
    jobText: `Software Engineer I — Payments Tools (Fintech, Series C)
New York or Remote US. $95,000–$120,000.
We're hiring an early-career engineer for our internal payments-operations tools team.
You will: build React dashboards our operations team uses daily; write Python services
that reconcile transactions; add tests to a growing data pipeline; ship small features
weekly with a senior mentor.
Requirements: 0–2 years of experience or strong internship background; working React
and Python; interest in fintech; evidence you have shipped something real people used.
Nice to have: internal-tools experience, reconciliation or ledger exposure.`,
  },
  {
    id: "internal-tools-eng",
    title: "Internal Tools Engineer (adjacent good fit)",
    expect: { bands: ["STRONG", "COMPETITIVE"], forbidRecommendations: ["NOT_RECOMMENDED"] },
    jobText: `Internal Tools Engineer (L2)
Remote US. We build the dashboards and workflow tools that keep a 300-person company
running. You'll own small tools end to end: talk to the ops team, build the React
front end, wire the Python backend, measure whether people actually use it.
Requirements: 1–3 years or equivalent internship experience; React + Python;
a shipped tool with real internal users you can talk about concretely.`,
  },
  {
    id: "junior-data-analyst",
    title: "Data Analyst (adjacent, function drift)",
    // Recalibrated after the first live run (2026-08-30): the scorer read
    // "daily-driver SQL + Tableau + explicitly not an engineering role" as
    // disqualifying and returned WEAK/NOT_RECOMMENDED — harsher than the
    // original guess and arguably MORE honest. The fixture now pins only the
    // ceiling: an adjacent-function ad may never be an APPLY.
    expect: { bands: ["WEAK", "DEVELOPING", "COMPETITIVE"], forbidRecommendations: ["APPLY", "APPLY_AFTER_TAILORING"] },
    jobText: `Junior Data Analyst
Chicago, hybrid. Analyze marketing-funnel data, build weekly dashboards, own SQL
reporting for two business teams.
Requirements: 0–2 years; strong SQL (daily driver); dashboarding (Tableau/Looker);
statistics coursework; stakeholder communication. Python a plus. This is an
analytics role, not a software engineering role.`,
  },
  {
    id: "staff-ml-research",
    title: "Staff ML Research Engineer (seniority + domain mismatch)",
    expect: { bands: ["WEAK", "DEVELOPING"], requireRecommendations: ["NOT_RECOMMENDED"] },
    jobText: `Staff Machine Learning Research Engineer
San Francisco. Own our foundation-model post-training research agenda.
Requirements: 8+ years in ML research or engineering; publications at NeurIPS/ICML
or equivalent industrial research record; deep PyTorch and CUDA optimization;
experience training large models across multi-node GPU clusters; PhD strongly
preferred. You will set direction for a team of research engineers.`,
  },
  {
    id: "marketing-manager",
    title: "Growth Marketing Manager (wrong function)",
    expect: { bands: ["WEAK"], requireRecommendations: ["NOT_RECOMMENDED"] },
    jobText: `Growth Marketing Manager
Austin, on-site. Own paid acquisition across Meta and Google, manage a $200k/month
budget, run creative testing with our agency, report CAC/LTV weekly to the CMO.
Requirements: 4+ years in growth or performance marketing; hands-on ads-platform
depth; landing-page conversion optimization; copywriting chops. Engineering
background not required and not relevant.`,
  },
];
