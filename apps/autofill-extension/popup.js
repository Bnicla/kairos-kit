// Popup: loads the profile, auto-matches the résumé to the job on the page,
// offers to generate one if none exists, and tells the content script to fill.
// Never submits.

const $ = (id) => document.getElementById(id);
let PROFILE = null;
let JOB = null; // { url, title, text, company } for the page in view

function setStatus(msg, cls) {
  const el = $("status");
  el.style.display = "block";
  el.textContent = msg;
  el.className = "status " + (cls || "");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Content scripts only auto-inject on pages loaded AFTER install. If the tab was
// already open, PING fails — so inject on demand, then retry.
async function ensureContent(tabId) {
  try {
    const p = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (p?.ok) return p.ats;
  } catch (_) { /* not injected yet */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    const p = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return p?.ats || null;
  } catch (_) { return null; }
}

// Company slug from an ATS application URL: greenhouse.io/<slug>/jobs/…,
// jobs.lever.co/<slug>/…, ashbyhq.com/<slug>/…
function companyFromUrl(url) {
  try {
    const u = new URL(url);
    let m;
    if (/greenhouse\.io$/.test(u.host)) m = u.pathname.match(/^\/([^/]+)\/jobs/);
    else if (/lever\.co$/.test(u.host)) m = u.pathname.match(/^\/([^/]+)\//);
    else if (/ashbyhq\.com$/.test(u.host)) m = u.pathname.match(/^\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]).replace(/[-_]+/g, " ").toLowerCase().trim() : null;
  } catch (_) { return null; }
}

function matchResume(resumes, slug) {
  if (!slug) return null;
  const s = slug.toLowerCase();
  return (resumes || []).find((r) => {
    const c = (r.company || "").toLowerCase().trim();
    return c && (c === s || c.includes(s) || s.includes(c));
  });
}

async function init() {
  const tab = await activeTab();
  const ats = await ensureContent(tab.id);

  const known = ["Greenhouse", "Lever", "Ashby"].includes(ats);
  if (!ats) {
    $("detect").textContent = "Couldn't reach this page — try reloading the tab.";
    $("detect").className = "sub warn";
  } else if (known) {
    $("detect").textContent = `${ats} form detected`;
    $("detect").className = "sub ok";
  } else {
    $("detect").textContent = "Form detected — will fill what it can";
    $("detect").className = "sub ok";
  }

  // Pull the job on the page (for résumé matching + possible generation).
  const slug = companyFromUrl(tab.url);
  try {
    const j = await chrome.tabs.sendMessage(tab.id, { type: "GET_JOB" });
    if (j?.ok) JOB = { url: j.url, title: j.title, text: j.text, company: slug ? title(slug) : "" };
  } catch (_) { JOB = slug ? { url: tab.url, title: "", text: "", company: title(slug) } : null; }

  // Load the profile from Kairos.
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_PROFILE" });
    if (!resp?.ok) throw new Error(resp?.error || "no response");
    PROFILE = resp.profile;
  } catch (e) {
    if (String(e.message).includes("token_required")) {
      $("tokenBox").style.display = "block";
      setStatus("Kairos requires a one-time token.\nPaste it below (see the path shown), then reopen this popup.", "warn");
    } else {
      setStatus("Can't reach Kairos at localhost:3000.\nIs the local dashboard running?\n\n(" + e.message + ")", "err");
    }
    return;
  }

  // Résumé picker, with auto-match to the job's company.
  const sel = $("resume");
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "— no résumé —";
  sel.appendChild(none);
  (PROFILE.resumes || []).forEach((r) => {
    const o = document.createElement("option");
    o.value = r.resume_url;
    o.textContent = `${r.company} — ${r.role}`.slice(0, 60);
    o.dataset.company = r.company || "";
    o.dataset.fileName = r.resume_file_name || "";
    sel.appendChild(o);
  });

  // Auto-select a résumé only on a real company match; otherwise leave it on
  // "— no résumé —" so a wrong-role résumé is never attached by accident.
  const matched = matchResume(PROFILE.resumes, slug);
  if (matched) {
    sel.value = matched.resume_url;
    $("matchTag").textContent = `· matched ${matched.company}`;
  }

  // ALWAYS offer to generate a résumé tailored to THIS posting: the matched one
  // may be for a different role at the same company, or there may be none.
  if (slug) {
    $("offer").style.display = "block";
    $("offerText").textContent = matched
      ? `Attached ${matched.company}'s résumé — but it may be for a different role. Generate one tailored to this posting?`
      : `No résumé tailored for ${title(slug)} yet.`;
  }

  $("fill").disabled = !(ats && PROFILE); // fill on any page we could inject into
}

function title(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }

$("fill").addEventListener("click", async () => {
  $("fill").disabled = true;
  setStatus("Reading the form with Claude… (a few seconds)", "");
  try {
    const tab = await activeTab();
    const resumePath = $("resume").value || null;
    const resumeLabel = $("resume").selectedOptions[0]?.textContent || "";
    const resumeFileName = $("resume").selectedOptions[0]?.dataset.fileName || "";
    const res = await chrome.tabs.sendMessage(tab.id, { type: "FILL", profile: PROFILE, resumePath, resumeLabel, resumeFileName });
    if (!res?.ok) throw new Error(res?.error || "no response from page");
    let msg = `Filled ${res.filled} field${res.filled === 1 ? "" : "s"} (${res.ats})${res.usedClaude ? " · mapped by Claude" : " · offline matcher"}.`;
    if (resumePath) {
      if (res.resumeAttached) {
        // Name the attached file back to the user so they can confirm it is the
        // right, tailored résumé (and see the same filename on the form).
        msg += `\nRésumé attached: ${res.attachedName || resumeLabel}`;
      } else {
        msg += res.resumeFound ? "\nRésumé upload found but couldn't attach — add it manually." : "\nNo file-upload field found.";
      }
    }
    msg += "\n\nReview everything, then submit yourself.";
    setStatus(msg, res.filled ? "ok" : "warn");
  } catch (e) {
    setStatus("Couldn't fill this page.\n(" + e.message + ")", "err");
  } finally {
    $("fill").disabled = false;
  }
});

$("generate").addEventListener("click", async () => {
  if (!JOB || !JOB.company) { setStatus("Couldn't read the job on this page.", "err"); return; }
  $("generate").disabled = true;
  setStatus(`Capturing ${JOB.company} and starting a tailored résumé…`, "");
  try {
    const { kairosToken } = await chrome.storage.local.get("kairosToken");
    const r = await fetch("http://localhost:3000/api/autofill-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(kairosToken ? { "X-Kairos-Token": kairosToken } : {}) },
      body: JSON.stringify({ url: JOB.url, company: JOB.company, title: JOB.title || JOB.company, text: JOB.text }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || r.status);
    setStatus(`Captured. Generating in Kairos (takes a few minutes).\nWatch the board, then reopen this to attach the ${JOB.company} résumé.`, "ok");
  } catch (e) {
    setStatus("Couldn't start generation.\n(" + e.message + ")", "err");
    $("generate").disabled = false;
  }
});

$("saveToken").addEventListener("click", async () => {
  const token = $("token").value.trim();
  if (!token) return;
  await chrome.storage.local.set({ kairosToken: token });
  $("tokenBox").style.display = "none";
  setStatus("Token saved. Reconnecting…", "ok");
  init();
});

init();
