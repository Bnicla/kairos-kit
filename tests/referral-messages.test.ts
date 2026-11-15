import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStore } from "@/store/local-fs";
import { createApplication, updateMeta } from "@kairos/engine/applications";
import { importLinkedInConnections, loadContacts } from "@kairos/engine/contacts";
import {
  MessageRejected,
  checkReferralMessage,
  defaultAsk,
  findContact,
  loadReferralMessages,
  referralMessageEvidence,
  saveReferralMessage,
  setReferralMessageState,
  ungroundedNames,
} from "@kairos/engine/referral-messages";
import { MESSAGE_MAX_CHARS, REFERRAL_MESSAGE_SYSTEM_PROMPT } from "@kairos/engine/prompts/referral-message";
import { checkProse, hardProseViolations } from "@kairos/engine/tools/prose-checks";

// Every person and company below is invented.

const KB_FILE = `---
id: ledgerly-engineer
company: Ledgerly
title: Software Engineer
start: '2023'
end: '2025'
---

## Achievements
- Built a reconciliation tool used every day by 40 people on the finance team. [R]
- Took part in the migration of the nightly export to a new scheduler. [R]
- Cut month-end close by 60%. [?]
`;

const CONNECTIONS = [
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Ada,Okafor,https://www.linkedin.com/in/ada-okafor,,Northwind Robotics,Staff Engineer,13 Nov 2024",
  'Ada,Castell,https://www.linkedin.com/in/ada-castell,,"Northwind Robotics, Inc.",Plant Manager,02 Jan 2019',
  "Chidi,Varga,https://www.linkedin.com/in/chidi-varga,,Northwind Robotics Europe,Buyer,05 Mar 2021",
  "Dana,Iwu,https://www.linkedin.com/in/dana-iwu,,Quillfeather Labs,Nurse Manager,30 Sep 2024",
].join("\n");

const POSTING_URL = "https://jobs.example.com/northwind/controls-engineer";

const GOOD = `Hi Ada,

I'm planning to apply for the Controls Engineer role at Northwind Robotics. At Ledgerly I built a reconciliation tool that 40 people on the finance team used every day, and the internal tools work in the posting is close to it.

Would you be open to a short call about the team?

Thanks,
Jordan`;

let store: LocalStore;
let home: string;
let appId: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kairos-messages-"));
  store = new LocalStore(home);
  await store.writeFile(["profile.md"], "---\nname: Jordan Example\ncontact_line: Springfield\n---\n# Candidate profile\n");
  await store.writeFile(["knowledge-base", "experiences", "01-ledgerly-engineer.md"], KB_FILE);
  await store.writeFile(["knowledge-base", "_voice-profile.md"], "Short sentences. Plain verbs.");
  appId = (
    await createApplication(store, {
      company: "Northwind Robotics",
      role: "Controls Engineer",
      snapshotMarkdown: "# Controls Engineer\nNorthwind Robotics builds internal tools for its plants. You will own the controls software of one line.",
      source_url: POSTING_URL,
    })
  ).id;
  await importLinkedInConnections(store, CONNECTIONS);
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("which contact a request names", () => {
  it("finds a person at the company by full name, part of a name, or profile address", async () => {
    const contacts = (await loadContacts(store))!.contacts;
    expect(findContact(contacts, "Northwind Robotics", "Ada Okafor")).toMatchObject({ contact: { name: "Ada Okafor" }, place: "at_company" });
    expect(findContact(contacts, "Northwind Robotics", "okafor").contact.name).toBe("Ada Okafor");
    expect(findContact(contacts, "Northwind Robotics", "https://www.linkedin.com/in/ada-castell/").contact.name).toBe("Ada Castell");
  });

  it("asks which one when a name fits two people, and says so when it fits nobody", async () => {
    const contacts = (await loadContacts(store))!.contacts;
    expect(() => findContact(contacts, "Northwind Robotics", "Ada")).toThrow(/More than one contact fits "Ada": Ada Okafor \(Staff Engineer\); Ada Castell \(Plant Manager\)/);
    expect(() => findContact(contacts, "Northwind Robotics", "Zed Nobody")).toThrow(/No contact fits/);
  });

  it("says when the person is at a similar company name or at another company", async () => {
    const contacts = (await loadContacts(store))!.contacts;
    expect(findContact(contacts, "Northwind Robotics", "Chidi").place).toBe("similar_company_name");
    expect(findContact(contacts, "Northwind Robotics", "Dana Iwu").place).toBe("another_company");
    // Someone at another company is found by full name only.
    expect(() => findContact(contacts, "Northwind Robotics", "Dana")).toThrow(/No contact fits/);
  });
});

describe("the evidence for a message", () => {
  it("holds the contact's four fields, the verified knowledge base and the user's words, and nothing else about the person", async () => {
    const e = await referralMessageEvidence(store, appId, { contact: "Ada Okafor" });
    expect(e.system_prompt).toBe(REFERRAL_MESSAGE_SYSTEM_PROMPT);
    expect(e).toMatchObject({ application_sent: false, ask: "conversation", relationship: null, contact_place: "at_company", existing_state: null });
    const payload = JSON.parse(e.user_message.split("```json\n")[1].split("\n```")[0]);
    expect(payload.contact).toEqual({ first_name: "Ada", name: "Ada Okafor", position: "Staff Engineer", company: "Northwind Robotics", connected_on: "2024-11-13" });
    expect(payload.relationship).toEqual({ in_the_senders_words: null });
    expect(payload.application).toEqual({ sent: false, applied_on: null });
    expect(payload.job).toMatchObject({ company: "Northwind Robotics", title: "Controls Engineer", url: POSTING_URL });
    expect(payload.candidate.name).toBe("Jordan Example");
    expect(payload.candidate.voice_profile).toContain("Plain verbs");
    // Unverified facts never reach the model.
    expect(JSON.stringify(payload.candidate.experiences)).toContain("reconciliation tool");
    expect(JSON.stringify(payload.candidate.experiences)).not.toContain("60%");
    expect(e.user_message).not.toContain("linkedin.com/in/");
  });

  it("passes on what the user said about knowing the person, as they said it, and then defaults to a referral", async () => {
    const said = "We were on the same team at Ledgerly in 2024";
    const e = await referralMessageEvidence(store, appId, { contact: "Ada Okafor", relationship: `  ${said}  ` });
    expect(e).toMatchObject({ ask: "referral", relationship: said });
    expect(e.user_message).toContain(`"in_the_senders_words": "${said}"`);
    expect(defaultAsk(null)).toBe("conversation");
    expect((await referralMessageEvidence(store, appId, { contact: "Ada Okafor", relationship: said, ask: "conversation" })).ask).toBe("conversation");
  });

  it("tells the model when the person's company is only a similar name", async () => {
    const e = await referralMessageEvidence(store, appId, { contact: "Chidi Varga" });
    expect(e.contact_place).toBe("similar_company_name");
    expect(e.user_message).toContain("do not say they work at the job's company");
  });

  it("the prompt keeps the rules that decide the design", () => {
    for (const rule of ["claim NO shared history", "NEVER fabricate", "send it themselves", "easy to decline", "No flattery", String(MESSAGE_MAX_CHARS)]) {
      expect(REFERRAL_MESSAGE_SYSTEM_PROMPT).toContain(rule);
    }
    expect(REFERRAL_MESSAGE_SYSTEM_PROMPT).not.toMatch(/—/);
  });
});

describe("the checks on a message", () => {
  const ctx = {
    contact: { first_name: "Ada", name: "Ada Okafor", position: "Staff Engineer", company: "Northwind Robotics" },
    relationship: null as string | null,
    evidence: `${KB_FILE}\nJordan Example\nControls Engineer\nNorthwind Robotics builds internal tools for its plants.\nAda Okafor Staff Engineer`,
    jobUrl: POSTING_URL,
  };
  const rules = (text: string, c = ctx) => checkReferralMessage(text, c).filter((v) => v.hard).map((v) => v.rule);

  it("passes a plain message that claims nothing outside the evidence", () => {
    expect(checkReferralMessage(GOOD, ctx)).toEqual([]);
    expect(hardProseViolations(checkProse(GOOD, { kind: "message" }))).toEqual([]);
    expect(checkReferralMessage(GOOD.replace("Thanks,", `${POSTING_URL}\n\nThanks,`), ctx)).toEqual([]);
  });

  it("refuses a shared history the user did not state, and accepts it once they did", () => {
    const text = GOOD.replace("I'm planning", "We worked together at Ledgerly. I'm planning");
    expect(rules(text)).toEqual(["shared-history"]);
    expect(rules(text, { ...ctx, relationship: "We worked together at Ledgerly" })).toEqual([]);
    for (const claim of ["It's been a while.", "As a fellow engineer, I", "I'd like to reconnect.", "Good to see you here."]) {
      expect(rules(GOOD.replace("I'm planning", `${claim} I'm planning`)), claim).toContain("shared-history");
    }
  });

  it("refuses a statement about the person that the four fields cannot support", () => {
    for (const claim of ["I saw your post about plant software.", "Congratulations on the new role.", "Your work on the line software is impressive.", "You've built a strong team."]) {
      expect(rules(GOOD.replace("I'm planning", `${claim} I'm planning`)), claim).toContain("contact-claim");
    }
  });

  it("refuses a name that is in none of the evidence", () => {
    expect(rules(GOOD.replace("At Ledgerly", "At Globex"))).toEqual(["ungrounded-name"]);
    expect(ungroundedNames("I worked at Globex with Hank Scorpio. Ledgerly came later.", "Ledgerly")).toEqual(["Globex", "Hank", "Scorpio"]);
    expect(ungroundedNames("Hi Ada,\nI used SQL at Ledgerly in March.\nJordan", "Ada Ledgerly sql")).toEqual([]);
  });

  it("refuses a stock opener, markdown, a placeholder, a foreign link, a missing greeting and a text over the limit", () => {
    expect(rules(GOOD.replace("I'm planning", "I hope you're doing well. I'm planning"))).toEqual(["stock-opener"]);
    expect(rules(GOOD.replace("Controls Engineer", "**Controls Engineer**"))).toEqual(["format"]);
    expect(rules(GOOD.replace("Hi Ada,", "Hi [First Name],"))).toEqual(expect.arrayContaining(["format", "greeting"]));
    expect(rules(GOOD.replace("Thanks,", "https://example.com/my-site\n\nThanks,"))).toEqual(["link"]);
    expect(rules(GOOD.replace("Hi Ada,", "Hi there,"))).toEqual(["greeting"]);
    expect(rules(`${GOOD}\n${"I built tools. ".repeat(200)}`)).toContain("length");
  });

  it("warns, without refusing, about a long message and a message that asks nothing", () => {
    const long = GOOD.replace("Would you", `${"I built a tool for the finance team at Ledgerly, and the team used it every day. ".repeat(6)}Would you`);
    expect(checkReferralMessage(long, ctx)).toEqual([expect.objectContaining({ rule: "length", hard: false })]);
    const noAsk = GOOD.replace("Would you be open to a short call about the team?", "I built it with the finance team.");
    expect(checkReferralMessage(noAsk, ctx)).toEqual([expect.objectContaining({ rule: "ask", hard: false })]);
  });

  it("the prose gate lets a message ask its question and still refuses a letter that does", () => {
    const question = "Would you be open to a short call about the team?";
    expect(checkProse(GOOD, { kind: "message" }).map((v) => v.rule)).not.toContain("rhetorical-question");
    expect(checkProse(`Dear team,\n\n${"I built tools for the finance team at Ledgerly. ".repeat(12)}${question}\n\nJordan`).map((v) => v.rule)).toContain("rhetorical-question");
    // The rest of the gate is the same for both.
    const flattery = GOOD.replace("Would you", "I look forward to hearing from you. Would you");
    expect(hardProseViolations(checkProse(flattery, { kind: "message" })).map((v) => v.rule)).toContain("stock-closer");
  });
});

describe("saving a draft and its state", () => {
  it("keeps a checked draft with the application, as drafted", async () => {
    const r = await saveReferralMessage(store, appId, { contact: "Ada Okafor", text: GOOD, at: "2026-11-13T10:00:00.000Z" });
    expect(r).toMatchObject({ saved: `applications/${appId}/referral-messages.json`, state: "drafted", warnings: [] });
    const [m] = await loadReferralMessages(store, appId);
    expect(m).toMatchObject({
      contact: { id: "li:ada-okafor", first_name: "Ada", name: "Ada Okafor", url: "https://www.linkedin.com/in/ada-okafor" },
      relationship: null,
      ask: "conversation",
      text: GOOD,
      state: "drafted",
      history: [{ state: "drafted", at: "2026-11-13T10:00:00.000Z" }],
    });
    expect(m.contact).not.toHaveProperty("email");
  });

  it("refuses a text the checks reject, with what to fix, and keeps the saved draft", async () => {
    const bad = GOOD.replace("I'm planning", "We worked together years ago. I'm planning").replace("40 people", "400 people");
    await expect(saveReferralMessage(store, appId, { contact: "Ada Okafor", text: bad })).rejects.toThrow(MessageRejected);
    await expect(saveReferralMessage(store, appId, { contact: "Ada Okafor", text: bad })).rejects.toThrow(/shared-history/);
    // A number that is not in the verified knowledge base: the unverified 60% line does not count as a source.
    const number = GOOD.replace("and the internal tools work", "cut month-end close by 60%, and the internal tools work");
    await expect(saveReferralMessage(store, appId, { contact: "Ada Okafor", text: number })).rejects.toThrow(/number\(s\) in the message.*60%/);
    expect((await loadReferralMessages(store, appId))[0].text).toBe(GOOD);
  });

  it("accepts the user's own account of how they know the person, and uses it as evidence", async () => {
    const said = "We met at the Tidewell robotics meetup in 2023";
    const text = GOOD.replace("I'm planning", "We met at the Tidewell robotics meetup in 2023. I'm planning");
    const r = await saveReferralMessage(store, appId, { contact: "Ada Okafor", relationship: said, ask: "referral", text });
    expect(r.state).toBe("drafted");
    const [m] = await loadReferralMessages(store, appId);
    expect(m).toMatchObject({ relationship: said, ask: "referral", text });
    expect(await loadReferralMessages(store, appId)).toHaveLength(1);
  });

  it("records sent and answered on the user's word, and does not overwrite a sent message", async () => {
    const sent = await setReferralMessageState(store, appId, "ada okafor", "sent", { note: "sent Tuesday", at: "2026-11-17T09:00:00.000Z" });
    expect(sent).toMatchObject({ state: "sent", history: [{ state: "drafted" }, { state: "sent", note: "sent Tuesday" }] });
    await expect(saveReferralMessage(store, appId, { contact: "Ada Okafor", text: GOOD })).rejects.toThrow(/marked sent/);
    expect((await referralMessageEvidence(store, appId, { contact: "Ada Okafor" })).existing_state).toBe("sent");

    const answered = await setReferralMessageState(store, appId, "li:ada-okafor", "answered");
    expect(answered.state).toBe("answered");
    await expect(setReferralMessageState(store, appId, "Zed Nobody", "sent")).rejects.toThrow(/No message fits/);
    await expect(setReferralMessageState(store, appId, "Ada Okafor", "delivered" as never)).rejects.toThrow(/Unknown state/);

    // Back to a draft, a new text can be saved.
    await setReferralMessageState(store, appId, "Ada Okafor", "drafted");
    await expect(saveReferralMessage(store, appId, { contact: "Ada Okafor", text: GOOD })).resolves.toMatchObject({ state: "drafted" });
  });

  it("drafts for a sent application when asked, saying it is sent", async () => {
    await updateMeta(store, appId, { status: "applied", applied_at: "2026-11-20T12:00:00.000Z" });
    const e = await referralMessageEvidence(store, appId, { contact: "Ada Castell" });
    expect(e.application_sent).toBe(true);
    expect(e.user_message).toContain('"applied_on": "2026-11-20"');
    const text = GOOD.replace("Hi Ada,", "Hi Ada,").replace("I'm planning to apply for", "I applied on November 20 for");
    await expect(saveReferralMessage(store, appId, { contact: "Ada Castell", text })).resolves.toMatchObject({ state: "drafted" });
    expect((await loadReferralMessages(store, appId)).map((m) => m.contact.name)).toEqual(["Ada Okafor", "Ada Castell"]);
  });

  it("says so when no connections are imported", async () => {
    const empty = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-messages-empty-")));
    const id = (await createApplication(empty, { company: "Northwind Robotics", role: "Controls Engineer", snapshotMarkdown: "# Role", source_url_unavailable: true })).id;
    await expect(referralMessageEvidence(empty, id, { contact: "Ada Okafor" })).rejects.toThrow(/No connections imported/);
    expect(await loadReferralMessages(empty, id)).toEqual([]);
  });
});
