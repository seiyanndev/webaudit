/**
 * chrome.storage.local wrappers. Each audit lives under `audit:<id>`;
 * a small index (newest first) powers history lists without loading full audits.
 */
const INDEX_KEY = 'auditIndex';
const MAX_AUDITS = 50;

export const DEFAULT_SETTINGS = {
  agencyName: '',
  agencyWebsite: '',
  agencyEmail: '',
  brandColor: '#5b5ef7',
  logo: null, // data URL
  footerNote: '',
  hourlyRate: 0, // 0 hides cost estimates
  currency: '$',
  hoursPerWeek: 20,
  maxLinks: 40,
  checkExternal: false,
  psiEnabled: true,
  psiApiKey: '',
  psiStrategy: 'mobile', // 'mobile' | 'desktop'
  aiEnabled: true,
  aiProvider: 'auto', // 'auto' (Gemini if a key is set, else Chrome built-in) | 'gemini' | 'chrome'
  geminiApiKey: '',
  geminiModel: 'gemini-3.8-flash',
  setupDone: false, // welcome page completed or skipped
  setupSkipped: false,
  // Client-facing pages
  consultantName: '',
  consultantTitle: '',
  consultantEmail: '',
  consultantPhone: '',
  consultantPhoto: null, // data URL
  introEnabled: true,
  introNote: '',  // empty = DEFAULT_INTRO
  ctaEnabled: true,
  ctaHeading: '',
  ctaMessage: '',
  ctaButton: '',
  ctaUrl: '',
  aiLabelsInPdf: true,
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (merged.brandColor === '#4f46e5') merged.brandColor = DEFAULT_SETTINGS.brandColor; // pre-rebrand default
  return merged;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function listAudits() {
  const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);
  return index;
}

export async function getAudit(id) {
  const key = `audit:${id}`;
  const out = await chrome.storage.local.get(key);
  return out[key] || null;
}

export async function saveAudit(audit) {
  const index = await listAudits();
  const entry = {
    id: audit.id,
    url: audit.url,
    host: audit.host,
    title: audit.title,
    createdAt: audit.createdAt,
    overall: audit.result.overall,
    scores: audit.result.scores,
  };
  const next = [entry, ...index.filter((e) => e.id !== audit.id)];
  const evicted = next.splice(MAX_AUDITS);
  await chrome.storage.local.set({ [`audit:${audit.id}`]: audit, [INDEX_KEY]: next });
  if (evicted.length) await chrome.storage.local.remove(evicted.map((e) => `audit:${e.id}`));
}

export async function updateAudit(id, patch) {
  const audit = await getAudit(id);
  if (!audit) return null;
  const next = { ...audit, ...patch };
  await chrome.storage.local.set({ [`audit:${id}`]: next });
  return next;
}

export async function deleteAudit(id) {
  const index = await listAudits();
  await chrome.storage.local.set({ [INDEX_KEY]: index.filter((e) => e.id !== id) });
  await chrome.storage.local.remove(`audit:${id}`);
}

export async function clearAudits() {
  const index = await listAudits();
  await chrome.storage.local.remove([INDEX_KEY, ...index.map((e) => `audit:${e.id}`)]);
}

const normalise = (url) => {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
};

/** Most recent earlier audit of the same page, for before/after comparison. */
export async function findPreviousAudit(url, excludeId) {
  const target = normalise(url);
  return (await listAudits()).find((e) => e.id !== excludeId && normalise(e.url) === target) || null;
}

// ───────────── per-client details, remembered by site so repeat audits reuse them ─────────────
const CLIENTS_KEY = 'clientProfiles';

const siteKey = (host) => String(host || '').replace(/^www\./, '').toLowerCase();

export async function getClientProfile(host) {
  const { [CLIENTS_KEY]: all = {} } = await chrome.storage.local.get(CLIENTS_KEY);
  return all[siteKey(host)] || {};
}

export async function saveClientProfile(host, patch) {
  const { [CLIENTS_KEY]: all = {} } = await chrome.storage.local.get(CLIENTS_KEY);
  const key = siteKey(host);
  all[key] = { ...all[key], ...patch };
  await chrome.storage.local.set({ [CLIENTS_KEY]: all });
  return all[key];
}

export const DEFAULT_INTRO = `Hi {client},

Thank you for the opportunity to review {website}. We ran a full audit covering speed, search visibility, accessibility, security and the mobile experience, and the site scored {score}/100 overall.

This report explains what we found in plain language, why each issue matters for your business, and a step-by-step plan to fix it, starting with the changes that will make the biggest difference.

I’d be glad to walk you through it.`;

export const DEFAULT_CTA = {
  heading: 'Let’s fix this together',
  message: 'We can take care of every item in this report, starting with the quick wins. Book a free call to talk through the results and agree on the next steps.',
  button: 'Book a call',
};
