/**
 * The names of the work, the same in every form of Kairos (Local, the Kit, the
 * connector, Cloud): six specialists, each named for one kind of work.
 *
 * They are names on the work (a byline on a score, a résumé, a list of jobs),
 * not voices: none of them speaks to the user. In Cloud a chief of staff calls
 * for their work. In the three other forms Claude does, and Kairos gives Claude
 * no other name.
 *
 * Wording only: nothing here changes what a tool does or what is saved.
 */
export const STAFF = {
  biographer: "Biographer",
  scout: "Scout",
  assessor: "Assessor",
  writer: "Writer",
  networker: "Networker",
  coach: "Interview Coach",
} as const;

export type StaffKey = keyof typeof STAFF;
export type StaffName = (typeof STAFF)[StaffKey];

/** The six names in the order they are listed everywhere. */
export const STAFF_NAMES: StaffName[] = Object.values(STAFF);

/** The one line about Claude, in the three forms that have no chief of staff of their own. */
export const CHIEF_OF_STAFF_LINE = "Claude is your chief of staff for your job search.";

/** What each specialist's work is, as one plain phrase after the name ("Assessor: scores a posting…"). */
export const STAFF_WORK: Record<StaffName, string> = {
  Biographer: "builds and keeps your knowledge base",
  Scout: "finds new job postings",
  Assessor: "scores a posting against your knowledge base and names the gaps",
  Writer: "writes the résumé, the cover letter and the answers to a form's questions",
  Networker: "shows who you know at a company and drafts a message to them",
  "Interview Coach": "prepares an interview with you",
};

/** The line about Claude followed by the six names, each with its work: the text a first run shows once. */
export function staffIntroduction(): string {
  return `${CHIEF_OF_STAFF_LINE} The work has six names: ${STAFF_NAMES.map((n) => `${n} (${STAFF_WORK[n]})`).join("; ")}.`;
}

/** The first-run text: the line about Claude, then the three specialists a new user meets first. */
export function firstRunIntroduction(): string {
  return `${CHIEF_OF_STAFF_LINE} Three specialists do the first work: the ${STAFF.biographer} builds your knowledge base from your résumé, the ${STAFF.assessor} scores a job ad against it, the ${STAFF.writer} drafts the résumé.`;
}

/** A title or a one-line description with its specialist in front: "Assessor: Score a job posting". With no specialist (the work is Claude's own) the text is unchanged. */
export const withStaff = (staff: StaffName | undefined, text: string): string => (staff ? `${staff}: ${text}` : text);
