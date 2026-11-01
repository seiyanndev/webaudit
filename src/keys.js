/**
 * Quick, quota-free API key checks used by the welcome page and Settings.
 *
 * - Gemini: listing models succeeds with any working key.
 * - PageSpeed: a request without a URL fails with "Required parameter: url"
 *   for a valid key, but "API key not valid" for a bad one — no test is run.
 *
 * Each check resolves to { ok: boolean, message: string }.
 */
const TIMEOUT_MS = 15000;

async function getJson(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, message: body?.error?.message || '' };
  } catch {
    return { status: 0, message: '' };
  } finally {
    clearTimeout(t);
  }
}

const INVALID = /API key not valid|API_KEY_INVALID|API key expired/i;
const DISABLED = /has not been used in project|SERVICE_DISABLED|is disabled|PERMISSION_DENIED/i;

export async function checkGeminiKey(key) {
  key = (key || '').trim();
  if (!key) return { ok: false, message: 'Enter a key.' };
  const { status, message } = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key });
  if (status === 200) return { ok: true, message: 'Key works. AI insights are ready.' };
  if (status === 429) return { ok: true, message: 'Key works (Google is rate-limiting it right now).' };
  if (status === 0) return { ok: false, message: 'Couldn’t reach Google. Check your internet connection.' };
  if (INVALID.test(message)) return { ok: false, message: 'This key isn’t valid. Copy it again from Google AI Studio.' };
  if (status === 403 || DISABLED.test(message)) {
    return { ok: false, message: 'This key can’t use the Gemini API. Create a key in Google AI Studio instead.' };
  }
  return { ok: false, message: `Google rejected this key (${status}${message ? `: ${message.slice(0, 120)}` : ''}).` };
}

export async function checkPsiKey(key) {
  key = (key || '').trim();
  if (!key) return { ok: false, message: 'Enter a key.' };
  const { status, message } = await getJson(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?key=${encodeURIComponent(key)}`);
  if (status === 400 && /Required parameter: url/i.test(message)) return { ok: true, message: 'Key works. Google PageSpeed is ready.' };
  if (status === 200 || status === 429) return { ok: true, message: 'Key works.' };
  if (status === 0) return { ok: false, message: 'Couldn’t reach Google. Check your internet connection.' };
  if (INVALID.test(message)) return { ok: false, message: 'This key isn’t valid. Copy it again from Google Cloud Console.' };
  if (status === 403 || DISABLED.test(message)) {
    return { ok: false, message: 'The PageSpeed Insights API isn’t enabled for this key’s project. Enable it in Google Cloud Console.' };
  }
  return { ok: false, message: `Google rejected this key (${status}${message ? `: ${message.slice(0, 120)}` : ''}).` };
}
