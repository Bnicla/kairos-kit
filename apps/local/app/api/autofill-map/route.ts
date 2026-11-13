import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/store";
import { runClaude } from "@/lib/claude-cli";
import { buildAutofillProfile, capFields, corsHeaders, rejectUnauthorized, extractMappingArray, filterSafeMappings, type MapField } from "@/lib/autofill";

export const dynamic = "force-dynamic";
// One Claude call maps the whole form; allow room for a cold CLI start.
export const maxDuration = 60;

/**
 * Semantic field mapper for the autofill extension.
 *
 * The extension scrapes every fillable field (label/question, type, options) and
 * POSTs the list here. We assemble the candidate's profile from ~/Kairos and ask
 * Claude (headless, Max-billed) to map each field to the right value, returning
 * { id -> value }. This replaces brittle keyword/regex matching with reasoning:
 * "authorised to work in the country where this job is based" is understood as a
 * work-authorization question in any phrasing, spelling, or language.
 *
 * Local-only: labels + profile go to Claude via the user's own account on their
 * machine. Only a chrome-extension origin may call it.
 */


export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

const SYSTEM = `You map job-application form fields to a candidate's profile. You are precise and never invent facts.

You are given the candidate PROFILE (JSON) and a list of FIELDS. Each field has: id, label (the question/label text), type (text | select | combobox | radio | toggle), and for choice types an "options" array.

Return ONLY a JSON array of { "id": "<field id>", "value": "<value>" } for the fields you can confidently fill FROM THE PROFILE. Rules:
- Use ONLY facts present in the profile. If a field asks for something not in the profile, OMIT it (do not guess).
- For choice fields WITH an "options" array (select, radio, toggle) the value MUST be copied verbatim from that array. If no option fits, OMIT the field.
- A "combobox" field usually has NO options listed (they render only when opened). Do NOT omit it for that reason: if the profile answers the question, return the short target value ("Yes", "No", "15+", "LinkedIn", a city) and the extension will open the dropdown and pick the closest option.
- For text fields, value is the exact string to type.
- Years-of-experience questions -> the common_answers entry whose key starts with "years_" (for example years_experience, or years_<field>_experience). With several such entries, use the one whose field the question asks about; if the question names a field that no entry covers, OMIT it. Willingness to travel to an on-site interview or for work -> common_answers.willing_to_travel_for_interviews / willing_to_travel_for_work. Start date -> common_answers.earliest_start_date.
- Work-authorization questions ("authorized/authorised to work", "right to work", "eligible to work") -> answer from work_authorization.authorized_us (true -> the affirmative option). Visa/sponsorship questions -> from work_authorization.requires_sponsorship.
- Demographic/EEO questions (gender, race/ethnicity, hispanic/latino, veteran, disability, sexual orientation) -> from eeo.
- "How did you hear" -> common_answers.how_did_you_hear.
- Name/email/phone/links/address -> contact / address / links.
- Location/"where are you based" -> contact.city or contact.location. A field about where the JOB or ROLE is based is NOT the candidate's location.
- Skip anything needing human judgment: essays ("why do you want to work here"), cover letters, salary if not in profile, consent/acknowledgement checkboxes, "additional information". OMIT them.
- Never output a value that is not either a verbatim option (choice fields) or a profile-derived string (text fields).

Output: a JSON array only. No prose, no code fences.`;


export async function POST(req: NextRequest) {
  // The token first: nothing from an unauthorized caller is read.
  const store = getStore();
  const denied = await rejectUnauthorized(req, store);
  if (denied) {
    return NextResponse.json({ error: denied.message }, { status: denied.status, headers: corsHeaders(req) });
  }
  if (Number(req.headers.get("content-length") ?? 0) > 1024 * 1024) {
    return NextResponse.json({ error: "Too many fields." }, { status: 413, headers: corsHeaders(req) });
  }
  let fields: MapField[] = [];
  try {
    const body = (await req.json()) as { fields?: MapField[] };
    fields = Array.isArray(body.fields) ? capFields(body.fields) : [];
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400, headers: corsHeaders(req) });
  }
  if (fields.length === 0) {
    return NextResponse.json({ mappings: [] }, { headers: corsHeaders(req) });
  }
  const profile = await buildAutofillProfile(store);
  // The extension never needs the résumé list for mapping; drop it to keep the
  // prompt lean and avoid leaking application history into the field-map call.
  const { resumes: _resumes, ...profileForMap } = profile;

  const prompt = `${SYSTEM}

PROFILE:
\`\`\`json
${JSON.stringify(profileForMap)}
\`\`\`

FIELDS:
\`\`\`json
${JSON.stringify(fields)}
\`\`\`

Return the JSON array of { id, value } now.`;

  try {
    const out = await runClaude(prompt, 55_000);
    const mappings = extractMappingArray(out);
    const safe = filterSafeMappings(fields, mappings, profileForMap);
    return NextResponse.json({ mappings: safe }, { headers: corsHeaders(req) });
  } catch (e) {
    return NextResponse.json(
      { error: `mapping failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, mappings: [] },
      { status: 502, headers: corsHeaders(req) },
    );
  }
}
