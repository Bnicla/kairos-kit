# Kairos Autofill (MVP)

A Chrome extension that fills job applications from your Kairos knowledge base.
Local-only, human-in-the-loop, **never auto-submits**.

## How it works

```
ATS page (Greenhouse/Lever/Ashby)
   │  content.js  — detects fields, maps to your profile, fills them
   │      │  chrome messaging
   │      ▼
   │  background.js — the only piece that talks to localhost
   │      │  fetch
   │      ▼
   └─ localhost:3000/api/autofill-profile   ← your profile (contact, work auth, EEO, work history)
      localhost:3000/api/file/<appId>/resume.docx  ← the résumé to attach
                    ▲
              ~/Kairos/autofill.json + knowledge base
```

- **Form fill needs no model** — it's pure data mapping. Runs offline.
- **Résumés** come from your applications (pick one in the popup).
- Nothing leaves your machine: the content script can't read localhost (CORS);
  only the extension's background worker can, and the API only answers a
  `chrome-extension://` origin.

## Prerequisites

1. The Kairos local dashboard running on `http://localhost:3000`
   (`npm -w kairos-local run dev`, or however you start it).
2. `~/Kairos/autofill.json` present (already created) — edit your EEO/demographic
   choices and standard answers there. Work history + résumés are automatic.

## Load it (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. **Load unpacked** → select this folder (`apps/autofill-extension/`)
4. Pin "Kairos Autofill" to the toolbar.

## Use it

1. Open a job application on Greenhouse, Lever, or Ashby.
2. Click the Kairos Autofill icon.
3. Pick the résumé to attach (defaults to your newest application's résumé).
4. Click **Fill this application**.
5. **Review every field**, fix anything the mapping missed, then submit yourself.

Filled fields flash green. The popup reports how many were filled and whether the
résumé attached.

## Scope / known limits (MVP)

- **Supported ATSes:** Greenhouse, Lever, Ashby (clean DOMs). Workday and iCIMS
  are not supported yet (custom web components / iframes — a bigger job).
- **Résumé format:** `.docx` (what Kairos renders). Most ATSes accept it; a PDF
  option can be added later via the `render_pdf` path.
- **Résumé auto-attach** is best-effort; some upload widgets intercept the file
  differently, in which case attach it manually.
- **Free-text questions** ("why this company?") are **not** drafted yet — that's
  Phase 2 (draft from the qa-bank via the local Max/`claude -p` channel, editable
  before it fills).

## Files

- `manifest.json` — MV3 config, host permissions, content-script matches.
- `background.js` — service worker; the only localhost caller.
- `content.js` — field detection, mapping, filling, résumé injection.
- `popup.html` / `popup.js` — the trigger UI + résumé picker.

Data bridge lives in the app: `apps/local/app/api/autofill-profile/route.ts`.
