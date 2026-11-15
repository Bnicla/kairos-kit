import { describe, expect, it } from "vitest";
import {
  CONTACTS_PATH,
  buildContactIndex,
  contactsAtCompany,
  diffContacts,
  importLinkedInConnections,
  loadContacts,
  matchCompany,
  normalizeCompany,
  parseConnectedOn,
  parseCsv,
  parseLinkedInConnections,
  qualifiesForReferrals,
  referralsForApplication,
  suggestReferrals,
  type Contact,
} from "@kairos/engine/contacts";
import { connectionsCsvFromZip, looksLikeZip } from "@kairos/engine/contacts-zip";
import JSZip from "jszip";
import { DEFAULT_REFERRAL_RULE, readProfileSettings, referralRule } from "@kairos/engine/settings";
import type { Store } from "@kairos/engine/store/types";

// Every person and company below is invented.

const NOTES = [
  "Notes:",
  '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed it, see the setting. You can learn more here"',
  "",
].join("\n");
const HEADER = "First Name,Last Name,URL,Email Address,Company,Position,Connected On";

const EXPORT = [
  NOTES,
  HEADER,
  "Ada,Okafor,https://www.linkedin.com/in/ada-okafor-1a2b3c,,Northwind Robotics,Staff Engineer,13 Nov 2026",
  'Bram,Castell,https://www.linkedin.com/in/bramcastell,bram@example.org,"Halden, Pike & Co.","Director, Product ""Platform""",02 Jan 2019',
  "Chidi,Varga,https://www.linkedin.com/in/chidi-varga,,,,5 Mar 2021",
  ",,,,Quillfeather Labs,Recruiter,07 Jul 2020",
  'Dana,"Iwu, PhD",https://www.linkedin.com/in/dana-iwu,,The Northwind Robotics Company,"Nurse Manager,\nNight Shift",30 Sep 2024',
  "Ada,Okafor,https://www.linkedin.com/in/ada-okafor-1a2b3c,,Northwind Robotics,Staff Engineer,13 Nov 2026",
  "",
].join("\n");

function memStore(files: Record<string, unknown> = {}): Store & { files: Record<string, unknown> } {
  const key = (p: string[]) => p.join("/");
  return {
    files,
    listFiles: async () => [],
    listFolders: async () => [],
    readFile: async (p) => (typeof files[key(p)] === "string" ? (files[key(p)] as string) : null),
    readBinary: async () => null,
    writeFile: async (p, content) => ((files[key(p)] = content), key(p)),
    writeBinary: async (p) => key(p),
    readJson: async <T,>(p: string[]) => (files[key(p)] && typeof files[key(p)] === "object" ? (files[key(p)] as T) : null),
    writeJson: async (p, data) => ((files[key(p)] = JSON.parse(JSON.stringify(data))), key(p)),
  };
}

const person = (name: string, company: string | null, over: Partial<Contact> = {}): Contact => {
  const [first_name, ...rest] = name.split(" ");
  return {
    id: `li:${name.toLowerCase().replace(/ /g, "-")}`,
    first_name,
    last_name: rest.join(" "),
    name,
    url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/ /g, "-")}`,
    email: null,
    company,
    position: "Engineer",
    connected_on: "2024-01-01",
    ...over,
  };
};

describe("parseCsv", () => {
  it("reads quoted commas, doubled quotes and line breaks inside quotes", () => {
    expect(parseCsv('a,"b, c","d ""e""","f\ng"\r\nh,,i')).toEqual([
      ["a", "b, c", 'd "e"', "f\ng"],
      ["h", "", "i"],
    ]);
  });

  it("drops a byte-order mark and keeps blank lines as empty rows", () => {
    expect(parseCsv("\ufeffa,b\n\nc,d\n")).toEqual([["a", "b"], [""], ["c", "d"]]);
  });
});

describe("parseLinkedInConnections", () => {
  const parsed = parseLinkedInConnections(EXPORT);

  it("skips the note lines before the header", () => {
    expect(parsed.rows).toBe(6);
    expect(parsed.contacts.map((c) => c.name)).toEqual(["Ada Okafor", "Bram Castell", "Chidi Varga", "Dana Iwu, PhD"]);
    expect(parsed.missing_columns).toEqual([]);
  });

  it("reads quoted fields: a comma in a company, quotes in a position, a line break in a position", () => {
    const bram = parsed.contacts[1];
    expect(bram.company).toBe("Halden, Pike & Co.");
    expect(bram.position).toBe('Director, Product "Platform"');
    expect(parsed.contacts[3].position).toBe("Nurse Manager, Night Shift");
  });

  it("gives null for empty values and reads the date", () => {
    const chidi = parsed.contacts[2];
    expect(chidi).toMatchObject({ company: null, position: null, email: null, connected_on: "2021-03-05" });
    expect(parsed.contacts[0].connected_on).toBe("2026-11-13");
  });

  it("identifies a person by their LinkedIn handle and counts skipped rows", () => {
    expect(parsed.contacts[0].id).toBe("li:ada-okafor-1a2b3c");
    expect(parsed.skipped).toEqual({ no_name: 1, duplicate: 1 });
  });

  it("drops email addresses unless asked to keep them", () => {
    expect(parsed.contacts.every((c) => c.email === null)).toBe(true);
    const kept = parseLinkedInConnections(EXPORT, { keepEmails: true });
    expect(kept.contacts[1].email).toBe("bram@example.org");
    expect(kept.contacts[0].email).toBeNull();
  });

  it("finds columns by name in any order and reports the missing ones", () => {
    const p = parseLinkedInConnections("Company,Last Name,First Name\nNorthwind Robotics,Okafor,Ada\n");
    expect(p.contacts[0]).toMatchObject({ name: "Ada Okafor", company: "Northwind Robotics", url: null, connected_on: null });
    expect(p.contacts[0].id).toBe("n:ada okafor|northwind robotics");
    expect(p.missing_columns).toEqual(["url", "email address", "position", "connected on"]);
  });

  it("keeps only linkedin.com profile addresses", () => {
    const p = parseLinkedInConnections(
      `${HEADER}\nEve,Lund,javascript:alert(1),,Northwind,Analyst,01 Feb 2020\nFinn,Abara,https://example.com/in/finn,,Northwind,Analyst,01 Feb 2020\n`,
    );
    expect(p.contacts.map((c) => c.url)).toEqual([null, null]);
  });

  it("accepts a file with a header and no connection", () => {
    expect(parseLinkedInConnections(`${NOTES}\n${HEADER}\n`).contacts).toEqual([]);
  });

  it("refuses a file that is not a connections file", () => {
    expect(() => parseLinkedInConnections("Company Name,Title,Started On\nNorthwind,Engineer,2020\n")).toThrow(/not a LinkedIn connections file/);
    expect(() => parseLinkedInConnections("")).toThrow();
  });

  it("reads the dates LinkedIn writes", () => {
    expect(parseConnectedOn("3 Sept 2022")).toBe("2022-09-03");
    expect(parseConnectedOn("2022-09-03")).toBe("2022-09-03");
    expect(parseConnectedOn("yesterday")).toBeNull();
  });
});

describe("company names", () => {
  it("sets aside case, punctuation, The and legal forms", () => {
    expect(normalizeCompany("The Northwind Robotics Company, Inc.")).toBe("northwind robotics");
    for (const [a, b] of [
      ["Northwind Robotics", "NORTHWIND ROBOTICS, INC."],
      ["Northwind Robotics LLC", "northwind robotics"],
      ["Halden, Pike & Co.", "Halden Pike and Company"],
      ["Brightwater Group", "Brightwater Holdings Ltd"],
      ["Société Lumière S.A.", "Societe Lumiere"],
      ["Pay Harbor", "PayHarbor"],
      ["Tidewell.io", "Tidewell"],
      ["O'Dell's Bakery", "ODells Bakery"],
    ]) {
      expect(matchCompany(a, b), `${a} / ${b}`).toBe("exact");
    }
  });

  it("takes another name a company gives in parentheses: its initials, a former name", () => {
    expect(matchCompany("Northwind Robotics Works (NRW)", "NRW")).toBe("exact");
    expect(matchCompany("Lanternfish (formerly Quillfeather Labs)", "Quillfeather Labs")).toBe("exact");
  });

  it("marks initials against the full name as related, to check", () => {
    expect(matchCompany("NRW", "Northwind Robotics Works Corporation")).toBe("related");
    expect(matchCompany("Halden & Pike", "H&P")).toBe("related");
    expect(matchCompany("NRX", "Northwind Robotics Works")).toBeNull();
    expect(matchCompany("Northwind Robotics Works", "Nimbus Rail Works")).toBeNull();
  });

  it("ignores a parenthesis that is not another name", () => {
    expect(matchCompany("Lanternfish (YC W21)", "Quillfeather (YC W21)")).toBeNull();
    expect(matchCompany("Lanternfish (Chicago)", "Lanternfish")).toBe("exact");
  });

  it("marks a longer or shorter form of the name as related, not exact", () => {
    expect(matchCompany("Northwind", "Northwind Robotics")).toBe("related");
    expect(matchCompany("Northwind Robotics Europe", "Northwind Robotics")).toBe("related");
  });

  it("does not match near-misses", () => {
    expect(matchCompany("Northwind", "Northwinds Capital")).toBeNull();
    expect(matchCompany("Lantern", "Lanternfish")).toBeNull();
    expect(matchCompany("Northwind Robotics", "Robotics Northwind")).toBeNull();
    expect(matchCompany("Halden Pike", "Pike Halden Partners")).toBeNull();
    expect(matchCompany("United", "United Lanternworks")).toBeNull();
    expect(matchCompany("", "Northwind")).toBeNull();
  });

  it("lists the contacts at a company, most recently connected first", () => {
    const contacts = [
      person("Ada Okafor", "Northwind Robotics", { connected_on: "2020-05-01" }),
      person("Bram Castell", "Northwind Robotics, Inc.", { connected_on: "2025-02-01" }),
      person("Chidi Varga", "Northwind Robotics Europe"),
      person("Dana Iwu", "Southwind Robotics"),
      person("Eve Lund", null),
    ];
    const found = contactsAtCompany(contacts, "Northwind Robotics");
    expect(found.exact.map((c) => c.name)).toEqual(["Bram Castell", "Ada Okafor"]);
    expect(found.related.map((c) => c.name)).toEqual(["Chidi Varga"]);
    expect(contactsAtCompany(buildContactIndex(contacts), "Quillfeather Labs")).toEqual({ exact: [], related: [] });
  });
});

describe("re-import", () => {
  it("counts added, removed, unchanged and updated people", () => {
    const before = [person("Ada Okafor", "Northwind"), person("Bram Castell", "Halden Pike"), person("Chidi Varga", "Tidewell")];
    const after = [person("Ada Okafor", "Northwind"), person("Bram Castell", "Lanternfish"), person("Dana Iwu", "Tidewell")];
    expect(diffContacts(before, after)).toEqual({ total: 3, added: 1, removed: 1, unchanged: 1, updated: 1 });
  });

  it("replaces the previous import in the data folder and reports the change", async () => {
    const store = memStore();
    const first = await importLinkedInConnections(store, EXPORT, { at: "2026-11-13T10:00:00.000Z" });
    expect(first).toMatchObject({ first_import: true, total: 4, added: 4, removed: 0, unchanged: 0, updated: 0, rows: 6, with_company: 3, emails_kept: 0 });

    const second = [
      HEADER,
      "Ada,Okafor,https://www.linkedin.com/in/ada-okafor-1a2b3c,,Northwind Robotics,Staff Engineer,13 Nov 2026",
      "Bram,Castell,https://www.linkedin.com/in/bramcastell,,Lanternfish,VP Product,02 Jan 2019",
      "Gus,Reyes,https://www.linkedin.com/in/gus-reyes,,Tidewell,Welder,09 Sep 2025",
    ].join("\n");
    const again = await importLinkedInConnections(store, second, { at: "2026-12-01T10:00:00.000Z" });
    expect(again).toMatchObject({ first_import: false, total: 3, added: 1, removed: 2, unchanged: 1, updated: 1 });

    const file = await loadContacts(store);
    expect(file?.imported_at).toBe("2026-12-01T10:00:00.000Z");
    expect(file?.contacts.map((c) => c.name)).toEqual(["Ada Okafor", "Bram Castell", "Gus Reyes"]);
    expect(Object.keys(store.files)).toEqual([CONTACTS_PATH.join("/")]);
  });

  it("leaves the previous import in place when the new file is not a connections file", async () => {
    const store = memStore();
    await importLinkedInConnections(store, EXPORT);
    await expect(importLinkedInConnections(store, "name,employer\nAda,Northwind\n")).rejects.toThrow();
    expect((await loadContacts(store))?.contacts).toHaveLength(4);
  });
});

describe("the rule that decides when contacts are shown", () => {
  const rule = DEFAULT_REFERRAL_RULE;
  const app = (score_band?: string, score_confidence?: string, recommendation = "APPLY", status = "scored") => ({
    score_band,
    score_confidence,
    recommendation,
    status,
  });

  it("defaults to COMPETITIVE or better with high confidence, on an application that is not sent yet", () => {
    expect(rule).toEqual({ enabled: true, min_band: "COMPETITIVE", min_confidence: "high", after_applying: false });
    expect(qualifiesForReferrals(app("STRONG", "high"), rule)).toBe(true);
    expect(qualifiesForReferrals(app("COMPETITIVE", "high"), rule)).toBe(true);
    expect(qualifiesForReferrals(app("STRONG", "medium"), rule)).toBe(false);
    expect(qualifiesForReferrals(app("DEVELOPING", "high"), rule)).toBe(false);
    expect(qualifiesForReferrals(app("WEAK", "high"), rule)).toBe(false);
  });

  it("never qualifies an application with no score, one the score advises against, or one that is over", () => {
    expect(qualifiesForReferrals(app(undefined, undefined), rule)).toBe(false);
    expect(qualifiesForReferrals(app("STRONG", "high", "NOT_RECOMMENDED"), rule)).toBe(false);
    for (const status of ["rejected", "withdrawn", "expired"]) {
      expect(qualifiesForReferrals(app("STRONG", "high", "APPLY", status), rule), status).toBe(false);
    }
    expect(qualifiesForReferrals({ ...app("STRONG", "high"), archived: true }, rule)).toBe(false);
  });

  it("stops once the application is sent", () => {
    for (const status of ["captured", "scored", "drafted"]) {
      expect(qualifiesForReferrals(app("STRONG", "high", "APPLY", status), rule), status).toBe(true);
    }
    for (const status of ["applied", "interviewing", "offer", "on_hold", "rejected", "withdrawn", "expired"]) {
      expect(qualifiesForReferrals(app("STRONG", "high", "APPLY", status), rule), status).toBe(false);
    }
  });

  it("keeps showing them after the application is sent when the profile says so, until the application is over", () => {
    const keep = referralRule(readProfileSettings("---\nreferrals:\n  after_applying: true\n---\n"));
    expect(keep).toEqual({ ...DEFAULT_REFERRAL_RULE, after_applying: true });
    for (const status of ["scored", "applied", "interviewing", "offer", "on_hold"]) {
      expect(qualifiesForReferrals(app("STRONG", "high", "APPLY", status), keep), status).toBe(true);
    }
    for (const status of ["rejected", "withdrawn", "expired"]) {
      expect(qualifiesForReferrals(app("STRONG", "high", "APPLY", status), keep), status).toBe(false);
    }
  });

  it("follows the profile's settings", () => {
    const settings = readProfileSettings("---\nreferrals:\n  min_band: strong\n  min_confidence: medium\n---\n");
    const custom = referralRule(settings);
    expect(custom).toEqual({ enabled: true, min_band: "STRONG", min_confidence: "medium", after_applying: false });
    expect(qualifiesForReferrals(app("STRONG", "medium"), custom)).toBe(true);
    expect(qualifiesForReferrals(app("COMPETITIVE", "high"), custom)).toBe(false);

    const off = referralRule(readProfileSettings("---\nreferrals:\n  enabled: false\n---\n"));
    expect(qualifiesForReferrals(app("STRONG", "high"), off)).toBe(false);
  });

  it("ignores a setting that is not a band or a confidence", () => {
    const settings = readProfileSettings("---\nreferrals:\n  min_band: excellent\n  min_confidence: 3\n  after_applying: sometimes\n---\n");
    expect(referralRule(settings)).toEqual(DEFAULT_REFERRAL_RULE);
    expect(referralRule(readProfileSettings(null))).toEqual(DEFAULT_REFERRAL_RULE);
  });
});

describe("the suggestion for one application", () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    id: "2026-11-13_northwind-robotics_staff-engineer",
    company: "Northwind Robotics",
    role: "Staff Engineer",
    status: "scored",
    captured_at: "2026-11-13T09:00:00.000Z",
    updated_at: "2026-11-13T09:00:00.000Z",
    score_band: "STRONG",
    score_confidence: "high",
    recommendation: "APPLY",
    ...over,
  });
  const metaPath = "applications/2026-11-13_northwind-robotics_staff-engineer/application-meta.json";

  it("returns the contacts of a qualifying application, without ids or emails", async () => {
    const store = memStore({ [metaPath]: meta() });
    await importLinkedInConnections(store, EXPORT, { keepEmails: true });
    const s = await suggestReferrals(store, meta().id);
    expect(s?.qualifies).toBe(true);
    expect(s?.contacts).toEqual([
      { name: "Ada Okafor", position: "Staff Engineer", company: "Northwind Robotics", url: "https://www.linkedin.com/in/ada-okafor-1a2b3c", connected_on: "2026-11-13" },
      { name: "Dana Iwu, PhD", position: "Nurse Manager, Night Shift", company: "The Northwind Robotics Company", url: "https://www.linkedin.com/in/dana-iwu", connected_on: "2024-09-30" },
    ]);
    expect(s?.related).toEqual([]);
  });

  it("suggests nothing below the rule, with nobody at the company, or with no import", async () => {
    const below = memStore({ [metaPath]: meta({ score_confidence: "medium" }) });
    await importLinkedInConnections(below, EXPORT);
    expect(await suggestReferrals(below, meta().id)).toBeNull();
    // The contacts are still there for a user who asks.
    expect((await referralsForApplication(below, meta({ score_confidence: "medium" }) as never)).contacts).toHaveLength(2);

    const nobody = memStore({ [metaPath]: meta({ company: "Quillfeather Works" }) });
    await importLinkedInConnections(nobody, EXPORT);
    expect(await suggestReferrals(nobody, meta().id)).toBeNull();

    const noImport = memStore({ [metaPath]: meta() });
    expect(await suggestReferrals(noImport, meta().id)).toBeNull();
    expect(await referralsForApplication(noImport, meta() as never)).toMatchObject({ imported_at: null, contacts: [], related: [] });

    expect(await suggestReferrals(memStore(), "no-such-application")).toBeNull();
  });
});

describe("the export archive", () => {
  const zipOf = async (entries: Record<string, string>) => {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(entries)) zip.file(name, content);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  };
  /** The same archive with another size stated for its files, in each file's header and in the archive's directory. */
  const stating = (bytes: Uint8Array, size: number) => {
    const out = new Uint8Array(bytes);
    const view = new DataView(out.buffer);
    for (let i = 0; i + 30 < out.length; i++) {
      if (out[i] !== 0x50 || out[i + 1] !== 0x4b) continue;
      if (out[i + 2] === 3 && out[i + 3] === 4) view.setUint32(i + 22, size, true);
      if (out[i + 2] === 1 && out[i + 3] === 2) view.setUint32(i + 24, size, true);
    }
    return out;
  };

  it("gives the connections file and opens no other; with a limit, refuses a file that unpacks to more, whatever size the archive states", async () => {
    const archive = await zipOf({ "Basic/Connections.csv": EXPORT, "messages.csv": "not read" });
    expect(looksLikeZip(archive)).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode(EXPORT))).toBe(false);
    // Without a limit, as the local product calls it.
    expect(await connectionsCsvFromZip(archive)).toBe(EXPORT);
    expect(await connectionsCsvFromZip(archive, { maxBytes: 1_000_000 })).toBe(EXPORT);
    await expect(connectionsCsvFromZip(archive, { maxBytes: 100 })).rejects.toThrow("too large to read");
    // An archive of a few kilobytes whose file unpacks to 3 MB and states 50 bytes: stopped at the limit.
    const small = await zipOf({ "Connections.csv": "a".repeat(3_000_000) });
    expect(small.length).toBeLessThan(10_000);
    await expect(connectionsCsvFromZip(stating(small, 50), { maxBytes: 1_000_000 })).rejects.toThrow("too large to read");
    await expect(connectionsCsvFromZip(await zipOf({ "Profile.csv": "x" }))).rejects.toThrow("holds no Connections.csv");
  });
});
