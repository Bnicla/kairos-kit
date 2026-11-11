// Kairos Autofill — content script.
// Fills a job application from your profile. NEVER clicks submit.
//
// Handles the real controls these forms use:
//   - text / email / tel / url / textarea      (label-based; names are often UUIDs)
//   - native <select>                          (Greenhouse)
//   - custom comboboxes                        (Ashby location typeahead + EEO dropdowns)
//   - radio groups (sentence labels)           (work auth / sponsorship / EEO)
//   - Yes/No BUTTON toggles                    (segmented pill controls)
// React-controlled inputs get a full event sequence so the framework registers them.

(() => {
  "use strict";

  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const has = (sig, ...ks) => ks.some((k) => sig.includes(k));
  // A combobox showing "Select..."/"Choose..." is EMPTY, not filled. Treating
  // placeholder text as a value made every unanswered dropdown invisible to the
  // mapper (the "Select..." bug: sponsorship/EEO dropdowns silently skipped).
  const isPlaceholder = (t) => { const v = norm(t); return !v || /^(select|choose|please select|pick one|none selected|--|—|…|\.\.\.)/.test(v); };

  function detectAts() {
    const h = location.host;
    if (h.includes("greenhouse")) return "Greenhouse";
    if (h.includes("lever")) return "Lever";
    if (h.includes("ashby")) return "Ashby";
    return "form";
  }

  // Text signature for a field, gathering every label-ish source.
  function signature(el) {
    const parts = [];
    const push = (t) => { if (t) parts.push(t); };
    if (el.labels) for (const l of el.labels) push(l.textContent);
    const aria = el.getAttribute && el.getAttribute("aria-labelledby");
    if (aria) aria.split(/\s+/).forEach((id) => push(document.getElementById(id)?.textContent));
    push(el.getAttribute && el.getAttribute("aria-label"));
    const wrap = el.closest && el.closest("label");
    if (wrap) push(wrap.textContent);
    push(el.getAttribute && el.getAttribute("placeholder"));
    push(el.getAttribute && el.getAttribute("name"));
    push(el.getAttribute && el.getAttribute("id"));
    return norm(parts.join(" ")).slice(0, 400);
  }

  // Label/question text found a few ancestors up (Ashby puts it higher in the tree).
  function groupContext(el) {
    let ctx = signature(el);
    let n = el;
    for (let i = 0; i < 6 && n; i++) {
      n = n.parentElement;
      const lab = n && n.querySelector("label, legend, h1, h2, h3, h4, [class*=label], [class*=question], [class*=Label]");
      if (lab && !lab.contains(el)) ctx += " " + norm(lab.textContent);
    }
    return ctx.slice(0, 500);
  }

  // Shared value matcher for options (radios / combobox options / <select>).
  function matchText(optText, desired) {
    const o = norm(optText), d = norm(desired);
    if (!o || !d) return false;
    if (o === d) return true;
    if ((d === "yes" || d === "no") && (o === d || o.startsWith(d + ",") || o.startsWith(d + " "))) return true;
    if (/decline|wish|prefer not/.test(d) && /decline|prefer not|don'?t wish|do not wish|not.*disclose|opt out|no answer/.test(o)) return true;
    if (o.includes(d) || d.includes(o)) return true;
    const dw = d.split(" ").filter((w) => w.length > 2);
    const ow = o.split(" ");
    const overlap = dw.filter((w) => ow.includes(w)).length;
    return dw.length > 0 && overlap / dw.length >= 0.6;
  }
  function bestOption(list, textOf, desired) {
    return list.find((o) => matchText(textOf(o), desired)) || null;
  }

  // Text-input rules (first match wins). Values come from the profile.
  function buildRules(p) {
    const c = p.contact || {}, a = p.address || {}, l = p.links || {}, e = p.eeo || {}, ca = p.common_answers || {}, id = p.identity || {};
    return [
      { t: (s) => has(s, "full name", "legal name", "legal first", "first and last", "full legal", "your name") && !has(s, "user", "company", "file"), v: () => c.full_name || id.full_name },
      { t: (s) => has(s, "first name", "given name") && !has(s, "preferred"), v: () => c.first_name },
      { t: (s) => has(s, "last name", "surname", "family name") && !has(s, "preferred"), v: () => c.last_name },
      { t: (s) => has(s, "preferred first", "preferred name"), v: () => ca.preferred_first_name || c.first_name },
      { t: (s) => has(s, "preferred last"), v: () => c.last_name },
      { t: (s) => has(s, "email", "e-mail"), v: () => c.email },
      { t: (s) => has(s, "phone", "mobile", "telephone"), v: () => c.phone },
      { t: (s) => has(s, "linkedin"), v: () => l.linkedin },
      { t: (s) => has(s, "github"), v: () => l.github },
      { t: (s) => has(s, "website", "portfolio", "personal site") && !has(s, "linkedin", "github"), v: () => l.website },
      { t: (s) => has(s, "mailing address", "street address", "physical address", "full address", "address line 1", "home address"), v: () => a.full },
      { t: (s) => has(s, "address") && !has(s, "email", "url", "linkedin", "website", "ip "), v: () => a.full },
      { t: (s) => has(s, "zip", "postal"), v: () => a.postal_code || c.postal_code },
      { t: (s) => has(s, "current or most recent employer", "current employer", "most recent employer", "current company"), v: () => id.current_employer },
      { t: (s) => has(s, "university or school", "school attended", "university attended"), v: () => id.school },
      { t: (s) => has(s, "city", "location (city", "current location", "where are you based"), v: () => c.city || c.location },
      { t: (s) => has(s, "state", "province") && !has(s, "united states", "statement"), v: () => c.state },
      { t: (s) => has(s, "country") && !has(s, "countries"), v: () => c.country },
      { t: (s) => has(s, "how did you hear", "how you heard", "source"), v: () => ca.how_did_you_hear },
      { t: (s) => has(s, "desired", "compensation", "salary expectation", "expected salary"), v: () => ca.desired_compensation },
      { t: (s) => has(s, "pronoun"), v: () => ca.pronouns },
      { t: (s) => has(s, "hispanic", "latino"), v: () => e.hispanic_latino },
      { t: (s) => has(s, "gender") && !has(s, "identity you identify"), v: () => e.gender },
      { t: (s) => has(s, "race", "ethnicity", "racial"), v: () => e.race_ethnicity },
      { t: (s) => has(s, "sexual orientation"), v: () => e.sexual_orientation },
      { t: (s) => has(s, "veteran"), v: () => e.veteran_status },
      { t: (s) => has(s, "disability", "disabled"), v: () => e.disability_status },
    ];
  }

  // What a Yes/No or option group should answer, from its label/question text.
  function desiredForGroup(ctx, p) {
    const wa = p.work_authorization || {}, e = p.eeo || {}, ca = p.common_answers || {}, c = p.contact || {};
    if (/sponsor|visa/.test(ctx)) return wa.requires_sponsorship ? "Yes" : "No";
    // Handle both American ("authorized") and British ("authorised") spellings.
    if (/(authoriz|authoris)[a-z]*\s+to\s+work|legally\s+(authoriz|authoris)|work\s+(authoriz|authoris)|right to work|eligible to work|permitted to work|allowed to work/.test(ctx)) return wa.authorized_us !== false ? "Yes" : "No";
    if (/gender identity|\bgender\b/.test(ctx)) return e.gender;
    if (/hispanic|latino/.test(ctx)) return e.hispanic_latino;
    if (/race|ethnic/.test(ctx)) return e.race_ethnicity;
    if (/sexual orientation/.test(ctx)) return e.sexual_orientation;
    if (/veteran/.test(ctx)) return e.veteran_status;
    if (/disabilit|disabled/.test(ctx)) return e.disability_status;
    if (/how did you hear|how you heard/.test(ctx)) return ca.how_did_you_hear;
    // Candidate's own location only. "country where this job is based" and
    // similar are about the ROLE, not the candidate, and must not return a city.
    if (!/job is based|role is based|position is based|country where|this (job|role|position)/.test(ctx) &&
        /where are you (currently )?based|current location|your location|current city|city and state/.test(ctx)) return c.city || c.location;
    return null; // consent, accommodation, custom questions: leave to the user
  }

  function fireInput(el, value) {
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function isFillable(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.type === "hidden") return false;
    const r = el.getBoundingClientRect();
    return !(r.width === 0 && r.height === 0);
  }
  function flash(el) { if (!el) return; const p = el.style.outline; el.style.outline = "2px solid #16a34a"; setTimeout(() => { el.style.outline = p; }, 1500); }

  // Text inputs, textareas, native <select>. Skips comboboxes (handled async).
  function fillFields(profile) {
    const rules = buildRules(profile);
    let filled = 0;
    for (const el of document.querySelectorAll("input[type=text], input[type=email], input[type=tel], input[type=url], input:not([type]), textarea, select")) {
      if (!isFillable(el) || el.getAttribute("role") === "combobox") continue;
      const sig = signature(el);
      const rule = rules.find((r) => r.t(sig));
      const value = rule && rule.v();
      if (!value) continue;
      if (el.tagName === "SELECT") {
        if (el.selectedIndex > 0 && norm(el.value) && !/^select/.test(norm(el.options[el.selectedIndex]?.textContent))) continue;
        const opt = bestOption(Array.from(el.options).filter((o) => o.value), (o) => o.textContent, String(value));
        if (opt) {
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
          if (setter) setter.call(el, opt.value); else el.value = opt.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          filled++; flash(el);
        }
      } else if (!norm(el.value)) {
        fireInput(el, String(value));
        filled++; flash(el);
      }
    }
    return filled;
  }

  function labelOf(el) {
    const l = el.labels?.[0] || el.closest("label") || (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby")));
    return norm(l?.textContent || el.getAttribute("aria-label") || "");
  }

  // Radio groups with descriptive labels (work auth / sponsorship / EEO).
  function fillRadios(profile) {
    const groups = {};
    document.querySelectorAll("input[type=radio]").forEach((el) => { if (isFillable(el)) (groups[el.name || "_" + Math.random()] = groups[el.name] || []).push(el); });
    let filled = 0;
    for (const els of Object.values(groups)) {
      if (els.some((el) => el.checked)) continue;
      const items = els.map((el) => ({ el, label: labelOf(el) })).filter((x) => x.label);
      const ctx = groupContext(els[0]) + " " + items.map((x) => x.label).join(" ");
      const desired = desiredForGroup(ctx, profile);
      if (!desired) continue;
      const want = bestOption(items, (x) => x.label, String(desired));
      if (want) { want.el.click(); filled++; flash(want.el.closest("label") || want.el); }
    }
    return filled;
  }

  // Yes/No (and similar) rendered as clickable BUTTONS, not radios.
  function fillToggles(profile) {
    const clickable = [...document.querySelectorAll("button, [role=button], [role=radio], [class*=option], [class*=toggle] > *, [class*=segment] > *")]
      // Never a submit button (a <button> in a form submits unless typed otherwise) or a link.
      .filter((el) => !(el.closest("a[href]") || ((el.tagName === "BUTTON" || el.tagName === "INPUT") && el.type === "submit")))
      .filter((el) => { const t = norm(el.textContent || el.value || ""); return (t === "yes" || t === "no") && isFillable(el); })
      .map((el) => ({ el, text: norm(el.textContent || el.value || "") }));
    const byQ = {};
    for (const it of clickable) { const q = groupContext(it.el); (byQ[q] = byQ[q] || []).push(it); }
    let filled = 0;
    for (const [q, items] of Object.entries(byQ)) {
      if (items.length < 2) continue;
      const already = items.find((x) => x.el.getAttribute("aria-pressed") === "true" || x.el.getAttribute("aria-checked") === "true" || /selected|active|checked/.test(x.el.className));
      if (already) continue;
      const desired = desiredForGroup(q, profile);
      if (desired !== "Yes" && desired !== "No") continue;
      const want = items.find((x) => x.text === norm(desired));
      if (want) { want.el.click(); filled++; flash(want.el); }
    }
    return filled;
  }

  function comboOptions(el) {
    const lbId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    const scope = (lbId && document.getElementById(lbId)) || document;
    return [...scope.querySelectorAll("[role=option]")].filter((o) => o.offsetParent !== null && norm(o.textContent));
  }

  // Custom comboboxes: location (geocoded typeahead) + discrete dropdowns (EEO, etc.).
  async function fillComboboxes(profile) {
    const c = profile.contact || {};
    let filled = 0;
    for (const el of document.querySelectorAll("input[role=combobox], [role=combobox], input[aria-haspopup=listbox], [aria-haspopup=listbox]")) {
      if (!isFillable(el) || !isPlaceholder(el.value || el.textContent)) continue;
      const ctx = groupContext(el);
      // Work-authorization / sponsorship / EEO questions frequently contain
      // "country" or "where ... based" (e.g. "authorised to work in the country
      // where this job is based"). Those are NOT candidate-location fields, so
      // route them through desiredForGroup; only treat a combobox as a location
      // typeahead when it is unambiguously about the candidate's own location.
      const workEeoCtx = /authoriz|authoris|sponsor|visa|eligible to work|right to work|gender|race|ethnic|veteran|disab|hispanic|latino|orientation/.test(ctx);
      const jobLocCtx = /job is based|role is based|position is based|country where|where this (job|role|position)/.test(ctx);
      const isLocation = !workEeoCtx && !jobLocCtx && /\blocation\b|where are you (currently )?based|current city|city and state/.test(ctx);
      const desired = isLocation ? (c.city || c.location) : desiredForGroup(ctx, profile);
      if (!desired) continue;
      if (isLocation && el.tagName === "INPUT") {
        // Type char-by-char so the async geocoder fires, then pick state + country.
        const typed = c.city || String(desired).split(",")[0];
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        for (let i = 1; i <= typed.length; i++) {
          if (setter) setter.call(el, typed.slice(0, i)); else el.value = typed.slice(0, i);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: typed[i - 1], inputType: "insertText" }));
          el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: typed[i - 1] }));
          el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: typed[i - 1] }));
          await sleep(110);
        }
        await sleep(2200);
        const opts = comboOptions(el);
        const want = norm(`${c.state || ""} ${c.country || ""}`).split(" ").filter(Boolean);
        const pick = opts.find((o) => want.length && want.every((w) => norm(o.textContent).includes(w))) || opts.find((o) => o.getAttribute("aria-selected") === "true") || opts[0];
        if (pick) { pick.click(); filled++; flash(el); }
      } else {
        // Discrete dropdown: open, then click the matching option.
        el.focus(); el.click();
        await sleep(350);
        const pick = bestOption(comboOptions(el), (o) => o.textContent, String(desired));
        if (pick) { pick.click(); filled++; flash(el); }
      }
      await sleep(180);
    }
    return filled;
  }

  function attachResume(base64, contentType, label, fileNameFromServer, candidateName) {
    const input = document.querySelector('input[type=file]');
    if (!input) return false;
    try {
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      const ct = contentType || "";
      const ext = ct.includes("pdf") ? ".pdf" : ct.includes("word") ? ".docx" : "";
      // Name the file with the company/role so the candidate can visually confirm
      // on the form that the correct tailored résumé was attached.
      const safe = (label || "").replace(/[—–]/g, "-").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
      // Server-provided name (Candidate_Name-company-resume.pdf, same rule as the
      // folder copies); the label-based name is the fallback for older servers.
      const fileName = fileNameFromServer && ext === ".pdf" ? fileNameFromServer
        : (candidateName || "Resume") + (safe ? " - " + safe : candidateName ? " Resume" : "") + ext;
      const file = new File([bytes], fileName, { type: ct || "application/octet-stream" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      flash(input.closest("div, label, li") || input);
      return true;
    } catch (e) { return false; }
  }

  // ---- Claude-mapped fill (semantic) --------------------------------------
  // Scrape every fillable field with its label/type/options, let Claude map it
  // to the profile server-side, then apply. Robust to any phrasing/language,
  // unlike the keyword matchers (which stay as the offline fallback below).
  const OFFICE_BTN = /submit|apply\b|next|back|continue|cancel|close|save|search|upload|attach|log ?in|sign ?in/;

  function collectFields() {
    const fields = [];
    const groups = { radio: {}, toggle: {} };
    let n = 0;
    const nextId = () => "kf" + n++;

    for (const el of document.querySelectorAll("input[type=text], input[type=email], input[type=tel], input[type=url], input:not([type]), textarea")) {
      if (!isFillable(el) || el.getAttribute("role") === "combobox" || el.type === "file" || norm(el.value)) continue;
      const id = nextId(); el.setAttribute("data-kf", id);
      fields.push({ id, label: groupContext(el).slice(0, 300), type: "text" });
    }
    for (const el of document.querySelectorAll("select")) {
      if (!isFillable(el) || el.getAttribute("role") === "combobox") continue;
      if (el.selectedIndex > 0 && norm(el.value) && !/^select/.test(norm(el.options[el.selectedIndex]?.textContent))) continue;
      const id = nextId(); el.setAttribute("data-kf", id);
      fields.push({ id, label: groupContext(el).slice(0, 300), type: "select", options: [...el.options].filter((o) => o.value).map((o) => o.textContent.trim()).filter(Boolean).slice(0, 60) });
    }
    for (const el of document.querySelectorAll("input[role=combobox], [role=combobox], [aria-haspopup=listbox]")) {
      if (!isFillable(el) || el.hasAttribute("data-kf")) continue;
      if (!isPlaceholder(el.value || el.textContent)) continue; // real value present
      const id = nextId(); el.setAttribute("data-kf", id);
      fields.push({ id, label: groupContext(el).slice(0, 300), type: "combobox" });
    }
    const rg = {};
    document.querySelectorAll("input[type=radio]").forEach((el) => { if (isFillable(el)) (rg[el.name || "_" + Math.random()] = rg[el.name] || []).push(el); });
    for (const els of Object.values(rg)) {
      if (els.some((e) => e.checked)) continue;
      const items = els.map((e) => ({ el: e, label: labelOf(e) })).filter((x) => x.label);
      if (items.length < 2) continue;
      const id = nextId(); groups.radio[id] = items;
      fields.push({ id, label: groupContext(els[0]).slice(0, 300), type: "radio", options: items.map((x) => x.label) });
    }
    const clickable = [...document.querySelectorAll("button, [role=button], [role=radio], [class*=option], [class*=toggle] > *, [class*=segment] > *")]
      .filter((el) => { const t = norm(el.textContent || el.value || ""); return t && t.length <= 30 && !OFFICE_BTN.test(t) && isFillable(el); })
      .map((el) => ({ el, text: norm(el.textContent || el.value || "") }));
    const byQ = {};
    for (const it of clickable) { const q = groupContext(it.el); (byQ[q] = byQ[q] || []).push(it); }
    for (const [q, items] of Object.entries(byQ)) {
      if (items.length < 2 || items.length > 8) continue;
      if (items.some((x) => x.el.getAttribute("aria-pressed") === "true" || x.el.getAttribute("aria-checked") === "true" || /selected|active|checked/.test(x.el.className))) continue;
      const id = nextId(); groups.toggle[id] = items;
      fields.push({ id, label: q.slice(0, 300), type: "toggle", options: items.map((x) => x.text) });
    }
    return { fields, groups };
  }

  // Numeric-bucket matcher: desired "15+" should land on "10+ years" or
  // "11-15 years" when no option says "15" verbatim. Picks the bucket that
  // contains the number, else the highest "N+" bucket at or below it.
  function numericBucketPick(opts, desired) {
    const n = parseInt(String(desired).match(/\d+/)?.[0] ?? "", 10);
    if (!Number.isFinite(n)) return null;
    let best = null, bestN = -1;
    for (const o of opts) {
      const t = norm(o.textContent);
      const range = t.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (range && n >= +range[1] && n <= +range[2]) return o;
      const plus = t.match(/(\d+)\s*\+|more than\s*(\d+)|(\d+)\s*or more/);
      const pn = plus ? +(plus[1] ?? plus[2] ?? plus[3]) : null;
      if (pn !== null && pn <= n && pn > bestN) { best = o; bestN = pn; }
    }
    return best;
  }

  async function fillOneCombobox(el, value) {
    el.focus();
    if (el.click) el.click();
    await sleep(350);
    let opts = comboOptions(el);
    let pick = bestOption(opts, (o) => o.textContent, value) || numericBucketPick(opts, value);
    if (!pick && el.tagName === "INPUT") {
      const typed = String(value).split(",")[0].trim();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      for (let i = 1; i <= typed.length; i++) {
        if (setter) setter.call(el, typed.slice(0, i)); else el.value = typed.slice(0, i);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: typed[i - 1], inputType: "insertText" }));
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: typed[i - 1] }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: typed[i - 1] }));
        await sleep(110);
      }
      await sleep(2000);
      opts = comboOptions(el);
      pick = bestOption(opts, (o) => o.textContent, value) || opts[0];
    }
    if (pick) { pick.click(); return true; }
    return false;
  }

  async function applyMappings(mappings, groups) {
    let filled = 0;
    for (const m of mappings) {
      const value = m && m.value;
      if (value == null || value === "") continue;
      if (groups.radio[m.id]) {
        const want = bestOption(groups.radio[m.id], (x) => x.label, String(value));
        if (want) { want.el.click(); filled++; flash(want.el.closest("label") || want.el); }
        continue;
      }
      if (groups.toggle[m.id]) {
        const want = groups.toggle[m.id].find((x) => matchText(x.text, String(value))) || bestOption(groups.toggle[m.id], (x) => x.text, String(value));
        if (want) { want.el.click(); filled++; flash(want.el); }
        continue;
      }
      const el = document.querySelector(`[data-kf="${m.id}"]`);
      if (!el || !isFillable(el)) continue;
      if (el.tagName === "SELECT") {
        const opt = bestOption([...el.options].filter((o) => o.value), (o) => o.textContent, String(value));
        if (opt) { const s = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set; if (s) s.call(el, opt.value); else el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); filled++; flash(el); }
      } else if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox") {
        if (await fillOneCombobox(el, String(value))) { filled++; flash(el); }
      } else {
        fireInput(el, String(value)); filled++; flash(el);
      }
    }
    return filled;
  }

  async function doFill(profile, resumePath, resumeLabel, resumeFileName) {
    let filled = 0, usedClaude = false;
    // Primary path: Claude maps the form semantically.
    try {
      const { fields, groups } = collectFields();
      if (fields.length) {
        const resp = await chrome.runtime.sendMessage({ type: "MAP_FIELDS", fields });
        if (resp?.ok && Array.isArray(resp.mappings) && resp.mappings.length) {
          filled = await applyMappings(resp.mappings, groups);
          usedClaude = true;
        }
      }
    } catch (e) { /* fall through to deterministic matchers */ }
    // Fallback: offline keyword matchers (server down / no token / empty result).
    if (!usedClaude) {
      filled = fillFields(profile) + fillRadios(profile) + fillToggles(profile) + (await fillComboboxes(profile));
    }
    let resumeAttached = false, attachedName = null, resumeFound = !!document.querySelector('input[type=file]');
    if (resumePath && resumeFound) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: "GET_FILE", path: resumePath });
        if (resp?.ok) {
          const input = document.querySelector('input[type=file]');
          resumeAttached = attachResume(resp.file.base64, resp.file.contentType, resumeLabel, resumeFileName,
            (profile.identity && profile.identity.full_name) || (profile.contact && profile.contact.full_name));
          if (resumeAttached) attachedName = input?.files?.[0]?.name || null;
        }
      } catch (e) { /* best effort */ }
    }
    return { ok: true, ats: detectAts(), filled, usedClaude, resumeFound, resumeAttached, attachedName };
  }

  function extractJob() {
    const title = (document.querySelector("h1")?.innerText || document.title || "").trim().slice(0, 200);
    const desc = document.querySelector("#content, .job__description, [class*=description], main, article");
    return { url: location.href, title, text: (desc?.innerText || document.body.innerText || "").slice(0, 25000) };
  }

  // Does THIS frame actually contain an application form? On embedded ATS pages
  // (e.g. a Greenhouse iframe inside a company careers site) the content script
  // runs in several frames; only the one holding the form should perform a FILL,
  // so an empty wrapper frame never hijacks the response with "filled 0".
  function hasApplicationForm() {
    if (document.querySelector('input[type=file]')) return true;
    if (document.querySelector('input[name*="first" i], input[id*="first_name" i], input[autocomplete="given-name"]')) return true;
    return document.querySelectorAll("input:not([type=hidden]), select, textarea").length >= 4;
  }

  // The popup injects into every frame of the tab. Only the page itself and
  // frames served by a supported job site take part: an ad or a widget from
  // another site embedded in the page never receives the profile or fills.
  const ATS_HOSTS = ["greenhouse.io", "lever.co", "ashbyhq.com"];
  function frameAllowed() {
    if (window === window.top) return true;
    const h = location.hostname;
    return ATS_HOSTS.some((d) => h === d || h.endsWith("." + d));
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!frameAllowed()) return false;
    if (msg.type === "PING") { sendResponse({ ok: true, ats: detectAts() }); return; }
    if (msg.type === "GET_JOB") { sendResponse({ ok: true, ats: detectAts(), ...extractJob() }); return; }
    if (msg.type === "FILL") {
      if (!hasApplicationForm()) return false; // let the form-bearing frame answer
      doFill(msg.profile, msg.resumePath, msg.resumeLabel, msg.resumeFileName).then(sendResponse);
      return true;
    }
  });
})();
