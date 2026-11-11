// Background service worker: the ONLY component that talks to localhost.
// Content scripts run in the page origin (greenhouse.io, etc.) and would be
// blocked by CORS; the service worker fetches with the extension's own origin,
// which the Kairos /api/autofill-profile route allows. All localhost access is
// funneled through here.

const KAIROS_BASE = "http://localhost:3000";

// Shared-secret auth: the server generates ~/Kairos/.secrets/autofill-token;
// the user pastes it once into the popup's settings and every request carries
// it. Without it the API refuses to serve the profile.
async function authHeaders() {
  const { kairosToken } = await chrome.storage.local.get("kairosToken");
  return kairosToken ? { "X-Kairos-Token": kairosToken } : {};
}

async function getProfile() {
  const res = await fetch(`${KAIROS_BASE}/api/autofill-profile`, {
    cache: "no-store",
    headers: await authHeaders(),
  });
  if (res.status === 401) throw new Error("token_required");
  if (!res.ok) throw new Error(`profile ${res.status}`);
  return res.json();
}

// Fetch a résumé/cover-letter docx and hand it back as base64 so it can cross
// the message boundary (structured clone won't reliably carry a File/Blob from
// a worker to a content script).
async function getFileBase64(path) {
  const headers = await authHeaders();
  let res = await fetch(`${KAIROS_BASE}${path}`, { cache: "no-store", headers });
  // If the PDF hasn't been rendered for this app, fall back to the .docx.
  if (!res.ok && path.endsWith(".pdf")) {
    res = await fetch(`${KAIROS_BASE}${path.replace(/\.pdf$/, ".docx")}`, { cache: "no-store", headers });
  }
  if (!res.ok) throw new Error(`file ${res.status}`);
  const buf = await res.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return {
    base64: btoa(binary),
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}

// Ask the local Kairos server to map scraped form fields to profile values via
// Claude. The server assembles the profile itself, so we send only the fields.
async function mapFields(fields) {
  const res = await fetch(`${KAIROS_BASE}/api/autofill-map`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    cache: "no-store",
    body: JSON.stringify({ fields }),
  });
  if (res.status === 401) throw new Error("token_required");
  if (!res.ok) throw new Error(`map ${res.status}`);
  return res.json(); // { mappings: [{id, value}] }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "GET_PROFILE") {
        sendResponse({ ok: true, profile: await getProfile() });
      } else if (msg.type === "GET_FILE") {
        sendResponse({ ok: true, file: await getFileBase64(msg.path) });
      } else if (msg.type === "MAP_FIELDS") {
        sendResponse({ ok: true, ...(await mapFields(msg.fields)) });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // keep the channel open for the async response
});
