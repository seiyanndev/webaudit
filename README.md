# Sitelume — Chrome Extension (MVP)

**Website health intelligence, client-ready in seconds.**

One-click website audits with a client-ready, white-labelled report you can save as PDF.

## Install (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin the extension, open any website, click the icon → **Run audit**.

No build step: plain JavaScript ES modules, Manifest V3.

## What it checks

| Category | Examples | Weight |
|---|---|---|
| Performance | LCP, FCP, CLS, TTFB, page weight, render-blocking scripts, image format/size/lazy-loading, compression, HTTP/2 | 25% |
| SEO & Content | Title, description, H1/heading order, canonical, noindex, robots.txt, sitemap, Open Graph, schema.org, thin content, broken/redirecting links | 20% |
| Accessibility | Alt text, form labels, button/link names, WCAG AA contrast, lang, zoom, duplicate IDs, landmarks, skip link | 20% |
| Security & Technical | HTTPS, mixed content, insecure forms, HSTS/CSP/XFO/XCTO/Referrer/Permissions headers, version disclosure, outdated jQuery, doctype, charset | 20% |
| Mobile & UX | Viewport, horizontal overflow, tap targets, small text, font/type-scale consistency, form input types & autocomplete | 15% |
| Tech Stack & Tracking | 81 fingerprints: CMS, frameworks, analytics, ad pixels, consent managers, CDN/hosting (not scored) | — |

Scoring: each category starts at 100 and is multiplied by `(1 − penalty)` per issue
(critical 30%, high 15%, medium 7%, low 3%). Priority is derived from severity × effort.

## First run

On install, Sitelume opens a welcome page (`onboarding/welcome.html`) asking for the two free Google keys
(Gemini for AI insights, PageSpeed for speed scores). Each key is checked against Google instantly, without using
quota (`src/keys.js`). Until setup is finished or skipped, the popup shows a "Finish setting up" screen instead
of the audit controls. Keys are optional: audits work without them, and "Skip for now" is always available.

## Google PageSpeed Insights

Each audit also runs Google's Lighthouse test (throttled mobile by default) and pulls real-visitor
Core Web Vitals from the Chrome UX Report. Performance issues use Google's numbers when available,
so scores line up with what clients see on pagespeed.web.dev.

- **Add a free API key** in Settings: the keyless shared quota is almost always exhausted.
  Create one at https://developers.google.com/speed/docs/insights/v5/get-started (enable the
  PageSpeed Insights API in a Google Cloud project; 25,000 requests/day free).
- Adds 15–60 seconds per audit (runs in parallel with the page scan).
- Only works for public URLs; localhost, staging behind a login, or bot-blocking sites are skipped
  with a note in the report, and the audit falls back to in-browser measurements.

## AI insights

With a Gemini key, AI insights are written automatically as the last step of every audit (`src/ai.js`). The AI
receives the audit plus the page's own copy, navigation, buttons and contact options, and produces: an executive
summary, 3 quick wins, a content & conversion review (value proposition, calls to action, trust signals, contact
options, local relevance) and site-specific fix steps for the top issues. Two engines, chosen in Settings → AI
insights (Automatic uses Gemini when a key is set):

- **Google Gemini API** (`gemini-3.8-flash` or `gemini-3.5-flash-lite`) with the user's own key from Google AI Studio.
  The free tier is enough for typical use: one request per report (about 2k tokens in). Audit data is sent to Google,
  and on the free tier Google may use it to improve its products.
- **Chrome built-in AI** (Gemini Nano, Prompt API). Free, no key, and audit data never leaves the computer;
  needs capable hardware.

Detection, severity and scores stay rule-based; the model only rewrites explanations,
and any output that mentions a number not present in the audit data is discarded. Results are saved with the
audit and included in the PDF. Toggle in Settings → AI insights.

## Client-facing pages

Set up once in Settings → Client-facing pages:

- **Consultant details** (name, title, email, phone, photo) used across the report.
- **Intro note** after the cover, a personal letter with placeholders {client}, {website}, {score},
  {consultant}, {agency}. Prints on its own page.
- **Closing “next steps” page** with the phase plan, a booking button, a QR code for print
  (`shared/vendor/qrcode.js`, MIT) and contact details. Prints as the final page.
- **Client logo on the cover:** add it on the report itself. The client's name and logo are remembered per
  website and reused on future audits of the same site.
- **AI labels in PDFs:** optional. When off, AI-written sections print with plain headings.

## Project structure

```
manifest.json
src/
  background.js   service worker — orchestrates an audit, saves it, opens the report
  collector.js    functions injected into the page (DOM, perf, headers, links, JS globals)
  psi.js          Google PageSpeed Insights API client (lab + field data)
  ai.js           AI insights: Google Gemini API or Chrome's built-in model (Prompt API)
  analyze.js      raw data → issues, scores, action plan, summary (pure functions)
  rules.js        knowledge base: why it matters / business impact / fix steps / effort
  tech.js         technology fingerprints
  storage.js      chrome.storage wrappers (settings, audit history)
  keys.js         quota-free checks that a Gemini / PageSpeed key works
onboarding/       first-run welcome page for API keys
popup/            toolbar popup: run audit, progress, recent audits
report/           dashboard + print-to-PDF report
options/          branding (logo, colour, agency details), rates, history
shared/           design tokens (light/dark) and UI helpers
icons/
```

## Permissions

- `activeTab` + `scripting` — read the current page only when you click the extension.
- `storage` / `unlimitedStorage` — audit history and screenshots stay on your machine.
- `<all_urls>` is **optional**, requested only if you enable “Also check external links”.
- `debugger` — used only by **Download PDF**: attaches to the Sitelume report tab for about a second, renders it with
  Chrome's PDF engine (`Page.printToPDF`, same print CSS as the print dialog), then detaches. Chrome doesn't allow this
  permission to be optional, so it shows an install warning and needs a justification in the Web Store listing.
  If it can't attach (e.g. DevTools is open on the report), the report falls back to the print dialog.

Internal link checks run from inside the page without cookies, and skip logout/delete-style URLs.

## Known limitations (MVP)

- Audits one page at the current desktop viewport; mobile checks are heuristics, not device emulation.
- Without PageSpeed (no key, or a non-public site), performance numbers come from the page load already in your tab.
- AI insights need a Gemini API key, or Chrome's built-in AI on capable hardware (Chrome 138+, 16 GB RAM or a 4 GB+ GPU). Without either, the rule-based text is used.
- Contrast checks skip text over background images.
- No backend, accounts or payments yet; API keys are per user and stored in the browser. See roadmap.

## Roadmap

1. TypeScript + Vite + Tailwind build (`@crxjs/vite-plugin`).
2. Laravel API: accounts, licence keys, Stripe/Paddle subscriptions, Free vs Pro limits.
3. Server-side headless Chromium worker: multi-page crawl, mobile emulation, full-page screenshots, server-rendered PDFs.
4. Move AI calls server-side (one agency key, usage limits per plan, no key setup for users).
5. Shareable report links, scheduled re-audits, team seats.

## Brand

| Token | Hex | Usage |
|---|---|---|
| Primary | `#5B5EF7` | Brand, CTA (default accent; agencies can override it) |
| Background | `#09090B` | App background |
| Surface | `#111318` | Cards |
| Border | `#272B35` | Borders |
| Text | `#FFFFFF` | Headings |
| Secondary | `#A1A7B3` | Body text |
| Success | `#22C55E` | Passed |
| Warning | `#F59E0B` | Warning |
| Critical | `#EF4444` | Failed |

Dark is the default theme. Light variants (darker status colours for contrast on white) are defined in
`shared/theme.css` and used for the report's light toggle and for PDF output. Typeface: Inter
(variable, bundled in `shared/fonts`, SIL Open Font License).

### Logo & icons

| File | Use |
|---|---|
| `assets/brand/source/` | Original artwork (glossy icon, white icon). Not loaded at runtime — leave out of the store ZIP. |
| `assets/brand/sitelume-mark-on-dark.png` | Mark with white brackets for dark surfaces (default UI). The name next to it is set in type (`logo()` in `shared/ui.js`). |
| `assets/brand/sitelume-mark-on-light.png` | Mark with near-black brackets for the light report theme and PDFs |
| `assets/brand/sitelume-mark.png` | Glossy mark alone, trimmed |
| `icons/icon32|48|128.png` | Glossy mark on a dark rounded tile |
| `icons/icon16.png` | White mark on the dark tile — the gradient blurs at 16px, so the toolbar uses the high-contrast version |
