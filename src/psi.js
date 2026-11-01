/**
 * Google PageSpeed Insights v5 client.
 *
 * Runs a Lighthouse lab test on Google's servers (throttled mobile or desktop)
 * and returns Chrome UX Report field data from real visitors when available.
 * The API sends CORS headers for extension origins, so no host permission is needed.
 *
 * runPsi() never throws: failures come back as { error } so the audit can continue.
 */
const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const TIMEOUT_MS = 90000;

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)|\.(local|test|localhost|internal|lan)$/i;

const FIELD_KEYS = {
  lcp: 'LARGEST_CONTENTFUL_PAINT_MS',
  inp: 'INTERACTION_TO_NEXT_PAINT',
  cls: 'CUMULATIVE_LAYOUT_SHIFT_SCORE',
  fcp: 'FIRST_CONTENTFUL_PAINT_MS',
  ttfb: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE',
};
const FIELD_RATING = { FAST: 'good', AVERAGE: 'average', SLOW: 'poor' };

export async function runPsi(url, { key = '', strategy = 'mobile' } = {}) {
  const base = { strategy, fetchedAt: new Date().toISOString() };
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return { ...base, skipped: true, error: 'Invalid URL.' };
  }
  if (PRIVATE_HOST.test(host)) {
    return { ...base, skipped: true, error: 'Google PageSpeed can only test publicly reachable websites, so it was skipped for this address.' };
  }

  const params = new URLSearchParams({ url, strategy, category: 'performance' });
  if (key) params.set('key', key.trim());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  let body;
  try {
    res = await fetch(`${ENDPOINT}?${params}`, { signal: ctrl.signal });
    body = await res.json();
  } catch (e) {
    return { ...base, error: e?.name === 'AbortError' ? 'Google PageSpeed took too long to respond (over 90 seconds).' : 'Could not reach Google PageSpeed. Check your internet connection.' };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || body?.error) return { ...base, error: friendlyError(res.status, body?.error?.message || '', !!key) };
  try {
    return { ...base, ...parse(body) };
  } catch (e) {
    console.warn('PSI parse failed', e);
    return { ...base, error: 'Google PageSpeed returned an unexpected response.' };
  }
}

function friendlyError(status, message, hasKey) {
  if (status === 429) {
    return hasKey
      ? 'Google PageSpeed quota for your API key is used up. Try again later.'
      : 'Google PageSpeed’s shared free quota is used up. Add your own free API key in Settings.';
  }
  if (/API key not valid|API_KEY_INVALID/i.test(message)) return 'The Google PageSpeed API key in Settings is not valid.';
  if (/has not been used in project|SERVICE_DISABLED|is disabled/i.test(message)) {
    return 'The PageSpeed Insights API is not enabled for your API key’s Google Cloud project.';
  }
  if (/FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|DNS_FAILURE|NO_FCP|NOT_HTML|Unable to process request/i.test(message)) {
    return 'Google could not load this page. It may be private, behind a login, or blocking automated visitors.';
  }
  return `Google PageSpeed error${status ? ` (${status})` : ''}: ${message.slice(0, 200) || 'unknown error'}`;
}

function parse(body) {
  const lh = body.lighthouseResult || {};
  const audits = lh.audits || {};
  const num = (id) => {
    const v = audits[id]?.numericValue;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const perf = lh.categories?.performance;

  if (lh.runtimeError?.code && lh.runtimeError.code !== 'NO_ERROR') {
    return { error: friendlyError(0, lh.runtimeError.code + ' ' + (lh.runtimeError.message || ''), true) };
  }

  const requests = audits['network-requests']?.details?.items;
  const lab = {
    lcp: round(num('largest-contentful-paint')),
    fcp: round(num('first-contentful-paint')),
    tbt: round(num('total-blocking-time')),
    cls: num('cumulative-layout-shift') == null ? null : Math.round(num('cumulative-layout-shift') * 1000) / 1000,
    si: round(num('speed-index')),
    bytes: round(num('total-byte-weight')),
    requests: Array.isArray(requests) ? requests.length : null,
  };

  // Opportunities: performance audits (outside the metrics group) that scored below "pass".
  const opportunities = [];
  for (const ref of perf?.auditRefs || []) {
    if (ref.group === 'metrics' || ref.group === 'hidden') continue;
    const a = audits[ref.id];
    if (!a || a.score === null || a.score === undefined || a.score >= 0.9) continue;
    if (!['numeric', 'binary', 'metricSavings'].includes(a.scoreDisplayMode)) continue;
    const savings = Math.max(a.details?.overallSavingsMs || 0, ...Object.values(a.metricSavings || {}).filter((v) => typeof v === 'number'));
    opportunities.push({ id: ref.id, title: stripMarkdown(a.title || ref.id), display: a.displayValue || '', savingsMs: Math.round(savings) });
  }
  opportunities.sort((x, y) => y.savingsMs - x.savingsMs);

  const shot = audits['final-screenshot']?.details?.data;

  return {
    score: typeof perf?.score === 'number' ? Math.round(perf.score * 100) : null,
    lighthouseVersion: lh.lighthouseVersion || null,
    lab,
    field: parseField(body.loadingExperience, 'page') || parseField(body.originLoadingExperience, 'origin'),
    opportunities: opportunities.slice(0, 8),
    screenshot: typeof shot === 'string' && shot.startsWith('data:image/') ? shot : null,
    warnings: (lh.runWarnings || []).map(stripMarkdown).slice(0, 5),
  };
}

function parseField(exp, scope) {
  const m = exp?.metrics;
  if (!m || !Object.keys(m).length) return null;
  const metrics = {};
  for (const [k, apiKey] of Object.entries(FIELD_KEYS)) {
    const x = m[apiKey];
    if (!x || typeof x.percentile !== 'number') continue;
    metrics[k] = {
      // CrUX reports CLS ×100 (e.g. 5 = 0.05).
      value: k === 'cls' ? x.percentile / 100 : x.percentile,
      rating: FIELD_RATING[x.category] || null,
    };
  }
  if (!metrics.lcp && !metrics.cls && !metrics.inp) return null;
  // Core Web Vitals pass when every available CWV (LCP, INP, CLS) is "good" at the 75th percentile.
  const cwv = ['lcp', 'inp', 'cls'].filter((k) => metrics[k]);
  return {
    scope,
    metrics,
    cwvPassed: cwv.every((k) => metrics[k].rating === 'good'),
    failing: cwv.filter((k) => metrics[k].rating !== 'good'),
  };
}

const round = (v) => (v == null ? null : Math.round(v));
const stripMarkdown = (s) => String(s).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, '');
