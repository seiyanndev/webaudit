/**
 * Turns raw page data into issues, scores, an action plan and a summary.
 * Pure functions only — safe to import from the service worker and pages.
 */
import { RULES } from './rules.js';
import { detectTechnologies, versionLt } from './tech.js';

export const CATEGORIES = [
  { id: 'performance', name: 'Performance', weight: 25, blurb: 'Loading speed and Core Web Vitals' },
  { id: 'seo', name: 'SEO & Content', weight: 20, blurb: 'Search visibility, content and links' },
  { id: 'accessibility', name: 'Accessibility', weight: 20, blurb: 'Usable by everyone, incl. assistive tech' },
  { id: 'security', name: 'Security & Technical', weight: 20, blurb: 'HTTPS, headers and code health' },
  { id: 'mobile', name: 'Mobile & UX', weight: 15, blurb: 'Responsive layout, forms and design consistency' },
  { id: 'tracking', name: 'Tech Stack & Tracking', weight: 0, blurb: 'Platform, analytics and consent', informational: true },
];
export const SCORED = CATEGORIES.filter((c) => c.weight > 0);
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
export const EFFORT_HOURS = { S: 2, M: 6, L: 16 };
export const EFFORT_LABEL = { S: 'Small · ~2h', M: 'Medium · ~6h', L: 'Large · ~2 days' };
export const PRIORITY_LABEL = { 1: 'Fix now', 2: 'Next', 3: 'Later' };
export const PHASES = {
  1: { title: 'Critical fixes & quick wins', description: 'Issues that hurt visitors, rankings or security today, plus high-value fixes that take little effort.' },
  2: { title: 'Core improvements', description: 'Meaningful improvements to speed, search visibility and usability.' },
  3: { title: 'Polish & optimisation', description: 'Best-practice refinements that round out a high-quality site.' },
};

// Each issue multiplies its category score by (1 - penalty), so scores fall
// quickly for serious problems but never go negative.
const PENALTY = { critical: 0.3, high: 0.15, medium: 0.07, low: 0.03 };

// ───────────── formatting helpers (shared with the UI) ─────────────
export const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
export const fmtBytes = (b) =>
  b == null ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`;
export const rate = (v, good, poor) => (v == null ? null : v <= good ? 'good' : v <= poor ? 'average' : 'poor');
export function gradeFor(score) {
  if (score >= 90) return { label: 'Excellent', tone: 'good' };
  if (score >= 75) return { label: 'Good', tone: 'good' };
  if (score >= 50) return { label: 'Needs improvement', tone: 'average' };
  return { label: 'Poor', tone: 'poor' };
}

function priorityOf(severity, effort) {
  if (severity === 'critical') return 1;
  if (severity === 'high') return effort === 'L' ? 2 : 1;
  if (severity === 'medium') return effort === 'L' ? 3 : 2;
  return 3;
}

function scoresFor(issues) {
  const out = {};
  for (const c of SCORED) {
    const factor = issues.filter((i) => i.category === c.id).reduce((acc, i) => acc * (1 - PENALTY[i.severity]), 1);
    out[c.id] = Math.round(100 * factor);
  }
  return out;
}

function overallFor(scores) {
  const total = SCORED.reduce((a, c) => a + c.weight, 0);
  return Math.round(SCORED.reduce((a, c) => a + scores[c.id] * c.weight, 0) / total);
}

/**
 * @param {object} input
 * @param {object} input.raw            result of collectPage()
 * @param {object} [input.globals]      result of detectGlobals()
 * @param {Array}  [input.internalLinks] checkLinks() results for same-origin links
 * @param {Array|null} [input.externalLinks] checkLinks() results for external links, or null if not checked
 * @param {object|null} [input.psi]    runPsi() result, or null when PageSpeed is disabled
 */
export function analyze({ raw, globals = {}, internalLinks = [], externalLinks = null, psi = null }) {
  const issues = [];
  const passed = [];
  const check = (id, fail, extra = {}) => {
    const rule = RULES[id];
    if (!rule) throw new Error(`Unknown rule: ${id}`);
    if (fail) {
      const items = extra.items || [];
      issues.push({
        id,
        category: rule.category,
        title: extra.title || rule.title,
        severity: extra.severity || rule.severity,
        effort: extra.effort || rule.effort,
        detail: extra.detail || '',
        items: items.slice(0, 15),
        itemCount: items.length,
        why: rule.why,
        impact: rule.impact,
        fix: rule.fix,
      });
    } else {
      passed.push({ id, category: rule.category, title: rule.pass });
    }
  };

  const p = raw.perf;
  const h = raw.headers?.map || null;
  const isHttps = raw.security.protocol === 'https:';
  const dpr = raw.viewportSize?.dpr || 1;

  // ───────────── Performance ─────────────
  // Prefer Google's throttled lab run (consistent, comparable with PageSpeed
  // Insights); fall back to the load already measured in the user's browser.
  const lab = psi && !psi.error && psi.lab ? psi.lab : null;
  const field = lab ? psi.field : null;
  const src = lab ? ` — Google ${psi.strategy} lab test` : ' — measured in your browser';
  const pick = (labVal, localVal) => (lab && labVal != null ? labVal : localVal);
  const lcp = pick(lab?.lcp, p.lcp);
  const fcp = pick(lab?.fcp, p.fcp);
  const cls = pick(lab?.cls, p.cls);
  const bytes = pick(lab?.bytes, p.transferBytes);
  const requests = pick(lab?.requests, p.requests);
  const bytesExact = lab?.bytes != null;

  if (field) {
    const names = { lcp: 'LCP', inp: 'INP', cls: 'CLS' };
    const show = (k) => (k === 'cls' ? field.metrics[k].value.toFixed(2) : fmtMs(field.metrics[k].value));
    check('perf-field-cwv', !field.cwvPassed, {
      severity: field.failing.some((k) => field.metrics[k].rating === 'poor') ? 'high' : 'medium',
      detail: `Based on the last 28 days of real Chrome visitors${field.scope === 'origin' ? ' across the whole site (not enough data for this page alone)' : ''}.`,
      items: field.failing.map((k) => `${names[k]}: ${show(k)} at the 75th percentile (${field.metrics[k].rating === 'poor' ? 'poor' : 'needs improvement'})`),
    });
  }
  if (lcp != null)
    check('perf-lcp', lcp > 2500, {
      severity: lcp > 4000 ? 'high' : 'medium',
      detail: `Largest Contentful Paint was ${fmtMs(lcp)}${src} (target: under 2.5 s).`,
      items: p.lcpElement ? [`LCP element: ${p.lcpElement}`] : [],
    });
  if (fcp != null)
    check('perf-fcp', fcp > 1800, {
      severity: fcp > 3000 ? 'medium' : 'low',
      detail: `First Contentful Paint was ${fmtMs(fcp)}${src} (target: under 1.8 s).`,
    });
  if (lab?.tbt != null)
    check('perf-tbt', lab.tbt > 200, {
      severity: lab.tbt > 600 ? 'high' : 'medium',
      detail: `Total Blocking Time was ${fmtMs(lab.tbt)}${src} (target: under 200 ms).`,
    });
  if (cls != null)
    check('perf-cls', cls > 0.1, {
      severity: cls > 0.25 ? 'high' : 'medium',
      detail: `Cumulative Layout Shift was ${cls}${src} (target: under 0.1).`,
    });
  if (p.ttfb != null)
    check('perf-ttfb', p.ttfb > 800, {
      severity: p.ttfb > 1800 ? 'high' : 'medium',
      detail: `The server took ${fmtMs(p.ttfb)} to respond (target: under 0.8 s).`,
    });
  check('perf-page-weight', bytes > 2.5 * 1048576, {
    severity: bytes > 5 * 1048576 ? 'high' : 'medium',
    detail: `The page downloads ${bytesExact ? '' : 'at least '}${fmtBytes(bytes)} (target: under 2.5 MB).`,
    items: Object.entries(p.byType)
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([k, v]) => `${k}: ${fmtBytes(v.bytes)} across ${v.count} file${v.count === 1 ? '' : 's'}${bytesExact ? ' (measured in your browser)' : ''}`),
  });
  check('perf-requests', requests > 80, {
    severity: requests > 150 ? 'medium' : 'low',
    detail: `The page makes ${requests} network requests (target: under 80).`,
  });
  check('perf-dom-size', p.domSize > 1500, {
    severity: p.domSize > 3000 ? 'medium' : 'low',
    detail: `The page contains ${p.domSize.toLocaleString()} HTML elements (target: under 1,500).`,
  });
  check('perf-render-blocking', p.blockingScripts.length > 0, {
    severity: p.blockingScripts.length >= 3 ? 'medium' : 'low',
    detail: `${p.blockingScripts.length} script${p.blockingScripts.length === 1 ? '' : 's'} block rendering.`,
    items: p.blockingScripts,
  });

  const imgs = raw.images.filter((i) => i.src && i.src !== 'data:…');
  // The same file often appears several times (e.g. header and footer logo): count and list each file once.
  const uniq = (list) => [...new Map(list.map((i) => [i.src, i])).values()];
  const legacy = uniq(imgs.filter((i) => i.bytes > 100 * 1024 && /\.(jpe?g|png|gif|bmp)(\?|#|$)/i.test(i.src)));
  check('perf-image-format', legacy.length > 0, {
    severity: legacy.length >= 3 ? 'medium' : 'low',
    detail: `${legacy.length} image${legacy.length === 1 ? '' : 's'} over 100 KB in JPEG/PNG/GIF format.`,
    items: legacy.map((i) => `${i.src} (${fmtBytes(i.bytes)})`),
  });
  const oversizedAll = imgs.filter((i) => i.visible && i.w > 0 && i.natW > i.w * dpr * 1.5 && i.natW - i.w * dpr > 300);
  const oversized = uniq(oversizedAll);
  const shownAt = (src) => [...new Set(oversizedAll.filter((o) => o.src === src).map((o) => o.w))].sort((a, b) => a - b).map((w) => `${w}px`).join(', ');
  check('perf-image-oversized', oversized.length > 0, {
    severity: oversized.length >= 5 ? 'medium' : 'low',
    detail: `${oversized.length} image${oversized.length === 1 ? ' is' : 's are'} served far larger than displayed.`,
    items: oversized.map((i) => `${i.src} — ${i.natW}px wide, displayed at ${shownAt(i.src)}`),
  });
  const eager = uniq(imgs.filter((i) => i.belowFold && i.loading !== 'lazy'));
  check('perf-lazy-loading', eager.length >= 3, {
    detail: `${eager.length} below-the-fold images load immediately.`,
    items: eager.map((i) => i.src),
  });
  const noDims = uniq(imgs.filter((i) => i.visible && !i.hasDims));
  check('perf-image-dimensions', noDims.length >= 3, {
    detail: `${noDims.length} visible images have no width/height attributes.`,
    items: noDims.map((i) => i.src),
  });
  if (h && raw.headers.status < 400) {
    const enc = (h['content-encoding'] || '').toLowerCase();
    check('perf-compression', !/(br|gzip|zstd|deflate)/.test(enc), { detail: 'The HTML response has no Content-Encoding header.' });
  }
  if (p.protocol) check('perf-http-protocol', /^http\/1/i.test(p.protocol), { detail: `Protocol: ${p.protocol}.` });

  // ───────────── SEO & Content ─────────────
  const s = raw.seo;
  const title = (s.title || '').trim();
  check('seo-title', !title || title.length < 10 || title.length > 65, {
    title: !title ? 'Page title is missing' : title.length < 10 ? 'Page title is too short' : 'Page title is too long',
    severity: !title ? 'high' : 'low',
    detail: title ? `“${title}” — ${title.length} characters (aim for 30–60).` : 'The page has no <title> element.',
  });
  const desc = (s.description || '').trim();
  check('seo-meta-description', !desc || desc.length < 50 || desc.length > 160, {
    title: !desc ? 'Meta description is missing' : desc.length < 50 ? 'Meta description is too short' : 'Meta description is too long',
    severity: !desc ? 'medium' : 'low',
    detail: desc ? `“${desc}” — ${desc.length} characters (aim for 70–160).` : 'No meta description found.',
  });
  const h1s = s.headings.filter((x) => x.level === 1);
  check('seo-h1', h1s.length !== 1, {
    title: h1s.length === 0 ? 'Page has no H1 heading' : `Page has ${h1s.length} H1 headings`,
    severity: h1s.length === 0 ? 'medium' : 'low',
    items: h1s.map((x) => x.text),
  });
  const skips = [];
  for (let i = 1; i < s.headings.length; i++) {
    const prev = s.headings[i - 1];
    const cur = s.headings[i];
    if (cur.level > prev.level + 1) skips.push(`H${prev.level} → H${cur.level}: “${cur.text}”`);
  }
  if (s.headings.length) check('seo-heading-order', skips.length > 0, { items: skips });
  check('seo-canonical', !s.canonical, {});
  const xRobots = h ? h['x-robots-tag'] || '' : '';
  const noindex = /noindex/i.test(s.robotsMeta || '') || /noindex/i.test(xRobots);
  check('seo-noindex', noindex, { detail: `Directive found: ${s.robotsMeta || xRobots}` });
  if (raw.robots) {
    check('seo-robots-txt', raw.robots.blocksAll || !raw.robots.found, {
      title: raw.robots.blocksAll ? 'robots.txt blocks all search engines' : 'No robots.txt file',
      severity: raw.robots.blocksAll ? 'critical' : 'low',
      detail: raw.robots.blocksAll ? 'robots.txt contains “User-agent: *” with “Disallow: /”.' : `Request for /robots.txt returned ${raw.robots.status || 'no response'}.`,
    });
  }
  if (raw.sitemap) check('seo-sitemap', !raw.sitemap.found, { detail: 'Checked robots.txt, /sitemap.xml, /sitemap_index.xml and /wp-sitemap.xml.' });
  const ogMissing = [['og:title', s.og.title], ['og:description', s.og.description], ['og:image', s.og.image]].filter(([, v]) => !v).map(([k]) => k);
  check('seo-open-graph', ogMissing.length > 0, { detail: `Missing: ${ogMissing.join(', ')}.`, items: [] });
  check('seo-structured-data', s.jsonLd.length === 0 && s.microdata === 0, {});
  check('seo-thin-content', s.wordCount < 300, { detail: `The page has about ${s.wordCount} words of visible text.` });
  check('seo-link-text', raw.links.genericText.length >= 3, { items: raw.links.genericText });

  const checkedInternal = internalLinks.filter((l) => !l.skipped);
  if (checkedInternal.length) {
    const broken = checkedInternal.filter((l) => l.status >= 400 || (l.status === 0 && l.error !== 'Timed out'));
    check('seo-broken-links', broken.length > 0, {
      severity: broken.length >= 3 ? 'high' : 'medium',
      detail: `${broken.length} of ${checkedInternal.length} internal links checked returned an error.`,
      items: broken.map((l) => `${l.status || 'No response'} — ${l.url}`),
    });
    const redirects = checkedInternal.filter((l) => l.redirected);
    check('seo-redirect-links', redirects.length >= 3, {
      detail: `${redirects.length} internal links go through a redirect.`,
      items: redirects.map((l) => l.url),
    });
  }
  if (externalLinks && externalLinks.length) {
    const dead = externalLinks.filter((l) => [404, 410].includes(l.status) || l.status >= 500 || (l.status === 0 && l.error === 'Request failed'));
    check('seo-broken-external', dead.length > 0, {
      detail: `${dead.length} of ${externalLinks.length} external links checked appear broken.`,
      items: dead.map((l) => `${l.status || 'No response'} — ${l.url}`),
    });
  }
  check('seo-favicon', !s.favicon, {});

  // ───────────── Accessibility ─────────────
  const a = raw.a11y;
  check('a11y-img-alt', a.imagesMissingAlt.length > 0, {
    severity: a.imagesMissingAlt.length >= 5 ? 'high' : 'medium',
    detail: `${a.imagesMissingAlt.length} visible image${a.imagesMissingAlt.length === 1 ? ' has' : 's have'} no alt attribute.`,
    items: a.imagesMissingAlt,
  });
  check('a11y-form-labels', a.unlabeledFields.length > 0, { items: a.unlabeledFields });
  check('a11y-button-name', a.unnamedButtons.length > 0, { items: a.unnamedButtons });
  check('a11y-link-name', a.unnamedLinks.length > 0, { items: a.unnamedLinks });
  if (a.contrastChecked > 0) {
    const n = a.contrastFailureCount;
    check('a11y-contrast', n > 0, {
      severity: n >= 10 ? 'high' : n >= 3 ? 'medium' : 'low',
      detail: `${n} of ${a.contrastChecked} text elements checked fall below WCAG AA contrast.`,
      items: a.contrastFailures,
    });
  }
  check('a11y-html-lang', !s.lang, {});
  check('a11y-zoom-disabled', a.zoomDisabled, { detail: `Viewport: ${raw.mobile.viewport}` });
  check('a11y-duplicate-ids', a.duplicateIds.length > 0, { items: a.duplicateIds });
  check('a11y-tabindex', a.positiveTabindex.length > 0, { items: a.positiveTabindex });
  check('a11y-landmarks', !a.hasMain, {});
  check('a11y-iframe-title', a.untitledIframes.length > 0, { items: a.untitledIframes });
  check('a11y-skip-link', !a.hasSkipLink, {});

  // ───────────── Security & Technical ─────────────
  const sec = raw.security;
  check('sec-https', !isHttps, { detail: `The page was loaded over ${sec.protocol.replace(':', '').toUpperCase()}.` });
  if (isHttps) check('sec-mixed-content', sec.mixedContent.length > 0, { items: sec.mixedContent });
  const realForms = raw.forms.filter((f) => f.fields > 0);
  const insecureForms = realForms.filter((f) => (isHttps && f.action.startsWith('http:')) || (!isHttps && f.hasPassword));
  if (realForms.length) check('sec-insecure-form', insecureForms.length > 0, { items: insecureForms.map((f) => `${f.name || 'form'} → ${f.action}`) });
  if (h) {
    const csp = h['content-security-policy'] || '';
    if (isHttps) check('sec-hsts', !h['strict-transport-security'], {});
    check('sec-csp', !csp, {
      detail: h['content-security-policy-report-only'] ? 'A report-only policy exists but is not enforced.' : '',
    });
    check('sec-clickjacking', !h['x-frame-options'] && !/frame-ancestors/i.test(csp), {});
    check('sec-xcto', (h['x-content-type-options'] || '').toLowerCase() !== 'nosniff', {});
    check('sec-referrer-policy', !h['referrer-policy'], {});
    check('sec-permissions-policy', !h['permissions-policy'], {});
    const leaks = [];
    if (/\d/.test(h.server || '')) leaks.push(`Server: ${h.server}`);
    if (/\d/.test(h['x-powered-by'] || '')) leaks.push(`X-Powered-By: ${h['x-powered-by']}`);
    if (/\d/.test(raw.tech.generator || '')) leaks.push(`<meta name="generator" content="${raw.tech.generator}">`);
    check('sec-version-disclosure', leaks.length > 0, { items: leaks });
    check('tech-http-status', raw.headers.status >= 400, { detail: `The server returned HTTP ${raw.headers.status}.` });
    check('tech-charset', !sec.hasMetaCharset && !/charset=/i.test(h['content-type'] || ''), {});
  }

  const tech = detectTechnologies(raw, globals);
  const jq = tech.find((t) => t.name === 'jQuery');
  if (jq && jq.version) {
    const old = versionLt(jq.version, '3.5.0');
    check('sec-outdated-jquery', old, {
      severity: versionLt(jq.version, '1.12.0') ? 'high' : 'medium',
      detail: `jQuery ${jq.version} detected (latest 3.x recommended).`,
    });
  }
  check('sec-target-blank', sec.unsafeBlankLinks > 0, {
    detail: `${sec.unsafeBlankLinks} link${sec.unsafeBlankLinks === 1 ? '' : 's'} with target="_blank" ${sec.unsafeBlankLinks === 1 ? 'lacks' : 'lack'} rel="noopener".`,
  });
  check('tech-doctype', !sec.doctype || sec.quirksMode, {});
  const dep = Object.entries(sec.deprecatedTags);
  check('tech-deprecated-html', dep.length > 0, { items: dep.map(([t, n]) => `<${t}> ×${n}`) });

  // ───────────── Mobile & UX ─────────────
  const m = raw.mobile;
  check('mob-viewport', !/width\s*=\s*device-width/i.test(m.viewport), { detail: m.viewport ? `Viewport: ${m.viewport}` : 'No viewport meta tag found.' });
  check('mob-horizontal-scroll', m.horizontalOverflow, {
    detail: `The page is ${m.scrollWidth}px wide inside a ${m.clientWidth}px window.`,
  });
  check('mob-tap-targets', m.smallTargetCount >= 3, {
    severity: m.smallTargetCount >= 10 ? 'medium' : 'low',
    detail: `${m.smallTargetCount} of ${m.interactiveCount} interactive elements are smaller than 24×24px.`,
    items: m.smallTargets,
  });
  check('mob-font-size', m.smallTextRatio > 0.2, {
    detail: `${Math.round(m.smallTextRatio * 100)}% of text elements are smaller than 12px.`,
  });
  const ICON_FONT = /icon|awesome|dashicons|material|glyph|eicons|fa-|ionicons|fontello/i;
  const textFonts = raw.design.fonts.filter(([f]) => !ICON_FONT.test(f));
  check('ux-font-families', textFonts.length > 4, { items: textFonts.map(([f, n]) => `${f} (${n} elements)`) });
  check('ux-font-sizes', raw.design.sizeCount > 15, { detail: `${raw.design.sizeCount} distinct font sizes are in use.` });
  const userForms = realForms.filter((f) => f.visible && !f.isSearch);
  if (userForms.length) {
    const noSubmit = userForms.filter((f) => !f.hasSubmit);
    check('form-no-submit', noSubmit.length > 0, { items: noSubmit.map((f) => f.name || f.action) });
    const wrongTypes = userForms.reduce((n, f) => n + f.emailAsText + f.phoneAsText, 0);
    check('form-input-types', wrongTypes > 0, { detail: `${wrongTypes} email/phone field${wrongTypes === 1 ? ' uses' : 's use'} type="text".` });
    const noAuto = userForms.reduce((n, f) => n + f.missingAutocomplete, 0);
    check('form-autocomplete', noAuto > 0, { detail: `${noAuto} personal-detail field${noAuto === 1 ? ' lacks' : 's lack'} autocomplete attributes.` });
  }

  // ───────────── Tech stack & tracking ─────────────
  const analytics = tech.filter((t) => t.analytics && !t.legacy);
  check('track-no-analytics', analytics.length === 0, {});
  check('track-universal-analytics', tech.some((t) => t.legacy), {});
  const needsConsent = tech.filter((t) => t.marketing || t.name === 'Google Analytics 4' || t.name === 'Universal Analytics');
  if (needsConsent.length) {
    check('track-consent', !tech.some((t) => t.consent), {
      detail: `Trackers found: ${needsConsent.map((t) => t.name).join(', ')}.`,
    });
  }

  // ───────────── scoring, prioritisation, plan ─────────────
  const sevRank = Object.fromEntries(SEVERITIES.map((sv, i) => [sv, i]));
  const catRank = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));
  for (const i of issues) {
    i.priority = priorityOf(i.severity, i.effort);
    i.hours = EFFORT_HOURS[i.effort];
  }
  issues.sort((x, y) => x.priority - y.priority || sevRank[x.severity] - sevRank[y.severity] || catRank[x.category] - catRank[y.category]);

  const scores = scoresFor(issues);
  const overall = overallFor(scores);
  const phases = [1, 2, 3].map((pr) => {
    const list = issues.filter((i) => i.priority === pr);
    return {
      priority: pr,
      ...PHASES[pr],
      issueCount: list.length,
      hours: list.reduce((n, i) => n + i.hours, 0),
      projectedOverall: overallFor(scoresFor(issues.filter((i) => i.priority > pr))),
    };
  });

  const counts = Object.fromEntries(SEVERITIES.map((sv) => [sv, issues.filter((i) => i.severity === sv).length]));
  // Each metric can have up to three readings: this browser, Google's lab run, and real visitors.
  const reading = (value, good, poor) => (value == null ? null : { value, rating: rate(value, good, poor) });
  const fieldReading = (k) => field?.metrics?.[k] || null;
  const metrics = [
    { id: 'lcp', label: 'Largest Contentful Paint', kind: 'ms', target: '< 2.5 s', local: reading(p.lcp, 2500, 4000), lab: reading(lab?.lcp, 2500, 4000), field: fieldReading('lcp') },
    { id: 'inp', label: 'Interaction to Next Paint', kind: 'ms', target: '< 200 ms', local: null, lab: null, field: fieldReading('inp') },
    { id: 'cls', label: 'Cumulative Layout Shift', kind: 'num', target: '< 0.1', local: reading(p.cls, 0.1, 0.25), lab: reading(lab?.cls, 0.1, 0.25), field: fieldReading('cls') },
    { id: 'fcp', label: 'First Contentful Paint', kind: 'ms', target: '< 1.8 s', local: reading(p.fcp, 1800, 3000), lab: reading(lab?.fcp, 1800, 3000), field: fieldReading('fcp') },
    { id: 'tbt', label: 'Total Blocking Time', kind: 'ms', target: '< 200 ms', local: null, lab: reading(lab?.tbt, 200, 600), field: null },
    { id: 'ttfb', label: 'Server Response (TTFB)', kind: 'ms', target: '< 0.8 s', local: reading(p.ttfb, 800, 1800), lab: null, field: fieldReading('ttfb') },
    { id: 'weight', label: 'Page Weight', kind: 'bytes', target: '< 2.5 MB', local: reading(p.transferBytes, 2.5 * 1048576, 5 * 1048576), lab: reading(lab?.bytes, 2.5 * 1048576, 5 * 1048576), field: null, localApprox: true },
    { id: 'requests', label: 'Requests', kind: 'count', target: '< 80', local: reading(p.requests, 80, 150), lab: reading(lab?.requests, 80, 150), field: null },
  ].filter((m) => m.local || m.lab || m.field);

  return {
    overall,
    grade: gradeFor(overall),
    scores,
    counts,
    issues,
    passed,
    phases,
    metrics,
    tech,
    design: {
      fonts: textFonts,
      sizes: [...raw.design.sizes].sort((x, y) => x[0] - y[0]),
      colors: raw.design.colors,
      backgrounds: raw.design.backgrounds,
    },
    checksRun: issues.length + passed.length,
    summary: buildSummary(raw, { overall, scores, issues, counts, phases, psi: lab ? psi : null }),
  };
}

function buildSummary(raw, { overall, scores, issues, counts, phases, psi }) {
  const host = new URL(raw.url).hostname.replace(/^www\./, '');
  const grade = gradeFor(overall);
  const total = issues.length;
  const parts = SEVERITIES.filter((sv) => counts[sv]).map((sv) => `${counts[sv]} ${sv}`);
  const ranked = [...SCORED].sort((x, y) => scores[y.id] - scores[x.id]);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const worstIssue = issues.find((i) => i.category === worst.id);

  const paragraphs = [
    `${host} scored ${overall}/100 overall — ${grade.label.toLowerCase()}. We ran automated checks across performance, SEO, accessibility, security and mobile experience and found ${total} issue${total === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}.`,
  ];
  if (psi && psi.score != null) {
    const device = psi.strategy === 'desktop' ? 'desktop' : 'mobile';
    const scope = psi.field?.scope === 'origin' ? ' (site-wide data)' : '';
    const fieldText = !psi.field
      ? 'There is not yet enough real-visitor data from Google to assess Core Web Vitals.'
      : psi.field.cwvPassed
        ? `Real visitors pass Google’s Core Web Vitals assessment${scope}.`
        : `Real visitors fail Google’s Core Web Vitals assessment${scope}, which can hold back search rankings.`;
    paragraphs.push(`Google PageSpeed Insights rates ${device} performance ${psi.score}/100. ${fieldText}`);
  }
  if (scores[best.id] !== scores[worst.id]) {
    paragraphs.push(
      `The strongest area is ${best.name} (${scores[best.id]}/100). The biggest opportunity is ${worst.name} (${scores[worst.id]}/100)${worstIssue ? `, where the main problem is: ${worstIssue.title.charAt(0).toLowerCase() + worstIssue.title.slice(1)}` : ''}.`
    );
  }
  const p1 = phases[0];
  paragraphs.push(
    p1.issueCount
      ? `We recommend starting with ${p1.issueCount} priority fix${p1.issueCount === 1 ? '' : 'es'}, estimated at around ${p1.hours} hours of work. Completing them is projected to raise the overall score from ${overall} to ${p1.projectedOverall}.`
      : 'There are no urgent fixes. The recommendations in this report focus on incremental improvements.'
  );
  return { headline: grade.label, paragraphs };
}
