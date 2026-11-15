import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHIEF_OF_STAFF_LINE, STAFF, STAFF_NAMES, STAFF_WORK, staffIntroduction, withStaff } from "@kairos/engine/staff";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const SKILL = read(".claude/skills/kairos/SKILL.md");
const COMMANDS = path.join(ROOT, ".claude/commands");
/** The `description:` of a command file, without its quotes. */
const description = (file: string) => read(`.claude/commands/${file}`).match(/^description: "?(.*?)"?$/m)![1];

describe("the names of the work", () => {
  it("are six, in one order, with one line about Claude", () => {
    expect(STAFF_NAMES).toEqual(["Biographer", "Scout", "Assessor", "Writer", "Networker", "Interview Coach"]);
    expect(Object.keys(STAFF_WORK)).toEqual(STAFF_NAMES);
    expect(CHIEF_OF_STAFF_LINE).toBe("Claude is your chief of staff for your job search.");
    const intro = staffIntroduction();
    expect(intro.startsWith(CHIEF_OF_STAFF_LINE)).toBe(true);
    for (const n of STAFF_NAMES) expect(intro).toContain(`${n} (`);
    // No article inside the product, and no chief of staff of Kairos's own.
    expect(intro).not.toMatch(/\bThe (Biographer|Scout|Assessor|Writer|Networker|Interview Coach)\b/);
    expect(withStaff(STAFF.assessor, "Score a job posting")).toBe("Assessor: Score a job posting");
    expect(withStaff(undefined, "Show the board")).toBe("Show the board");
  });

  it("the skill lists the six in the same order, says the line once, and names a specialist under every workflow", () => {
    const section = SKILL.split(/^## /m).find((s) => s.startsWith("The staff"))!;
    const rows = [...section.matchAll(/^\| (Biographer|Scout|Assessor|Writer|Networker|Interview Coach) \|/gm)].map((m) => m[1]);
    expect(rows).toEqual(STAFF_NAMES);
    expect(SKILL.replace(/\s+/g, " ").split(CHIEF_OF_STAFF_LINE).length - 1).toBe(1);
    expect(section).toMatch(/Kairos\s+gives you no other name and no persona/);
    const workflows = SKILL.split(/^## /m).filter((s) => s.startsWith("Workflow "));
    expect(workflows.length).toBe(12);
    for (const w of workflows) {
      const who = w.match(/^Specialist: \*\*(.+?)\*\*\.$/m)?.[1];
      expect(STAFF_NAMES, w.split("\n")[0]).toContain(who);
    }
  });

  it("each command says whose work it is: a specialist's name in front of its description, or none for Claude's own", () => {
    const owner: Record<string, string | null> = {
      "setup.md": STAFF.biographer,
      "find.md": STAFF.scout,
      "score.md": STAFF.assessor,
      "tailor.md": STAFF.writer,
      "letter.md": STAFF.writer,
      "message.md": STAFF.networker,
      "prep.md": STAFF.coach,
      "status.md": null,
      "apply.md": null,
      "update.md": null,
    };
    expect(readdirSync(COMMANDS).sort()).toEqual(Object.keys(owner).sort());
    for (const [file, who] of Object.entries(owner)) {
      const d = description(file);
      if (who) {
        expect(d.startsWith(`${who}: `), file).toBe(true);
        expect(read(`.claude/commands/${file}`), file).toContain(`the ${who}'s work`);
      } else expect(d, file).not.toMatch(/^(Biographer|Scout|Assessor|Writer|Networker|Interview Coach): /);
    }
    // The first run says the line once.
    expect(read(".claude/commands/setup.md").replace(/\s+/g, " ")).toContain(`"${CHIEF_OF_STAFF_LINE}"`);
  });

  it("the Kit's README names the six and says the line", () => {
    // The Kit's README is kit/files/README.md in the source repository and README.md in the exported Kit.
    const readme = read(existsSync(path.join(ROOT, "kit/files/README.md")) ? "kit/files/README.md" : "README.md").replace(/\s+/g, " ");
    expect(readme).toContain(CHIEF_OF_STAFF_LINE);
    for (const n of STAFF_NAMES) expect(readme).toContain(`| ${n} |`);
  });
});
