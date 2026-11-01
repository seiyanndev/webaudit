/**
 * Page collectors.
 *
 * Every exported function here is injected into the audited tab with
 * chrome.scripting.executeScript({ func }). Chrome serialises the function
 * source, so each one must be fully self-contained: no imports, no references
 * to anything outside its own body, and a JSON-serialisable return value.
 */

/** Gathers DOM, performance and same-origin network data. Runs in the isolated world. */
export async function collectPage() {
  const doc = document;
  const here = new URL(location.href);
  const isHttp = here.protocol === 'http:' || here.protocol === 'https:';

  // ---------- helpers ----------
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n = 120) => {
    s = clean(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const abs = (u) => {
    try {
      return new URL(u, here).href;
    } catch {
      return null;
    }
  };
  const metaName = (n) => doc.querySelector(`meta[name="${n}" i]`)?.getAttribute('content') ?? null;
  const metaProp = (p) => doc.querySelector(`meta[property="${p}" i]`)?.getAttribute('content') ?? null;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList && el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    const hint =
      el.getAttribute('aria-label') ||
      (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
        ? el.getAttribute('name') || el.getAttribute('placeholder')
        : el.innerText) ||
      el.getAttribute('src') ||
      el.getAttribute('href') ||
      '';
    const t = clip(hint, 70);
    return t ? `${s} — "${t}"` : s;
  };
  const accName = (el) => {
    const labelledBy = (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => doc.getElementById(id)?.textContent || '')
      .join(' ');
    const inner = [...el.querySelectorAll('img[alt], svg title, [aria-label]')]
      .map((n) => n.getAttribute('alt') || n.getAttribute('aria-label') || n.textContent)
      .join(' ');
    return clean(
      el.getAttribute('aria-label') ||
        labelledBy ||
        el.innerText ||
        el.textContent ||
        inner ||
        el.getAttribute('title') ||
        (el.tagName === 'INPUT' ? el.value : '') ||
        ''
    );
  };
  const timedFetch = async (url, init = {}, ms = 8000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  };
  const buffered = (type) =>
    new Promise((resolve) => {
      const out = [];
      try {
        const po = new PerformanceObserver((list) => out.push(...list.getEntries()));
        po.observe({ type, buffered: true });
        setTimeout(() => {
          out.push(...po.takeRecords());
          po.disconnect();
          resolve(out);
        }, 250);
      } catch {
        resolve(out);
      }
    });
  const parseColor = (c) => {
    const m = c && c.match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const luminance = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const effectiveBg = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // can't know what's under text
      const c = parseColor(cs.backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    let out = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    }
    return out;
  };
  const tally = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  // ---------- performance ----------
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
  const [lcpEntries, shiftEntries] = await Promise.all([buffered('largest-contentful-paint'), buffered('layout-shift')]);
  const lcpLast = lcpEntries[lcpEntries.length - 1];

  // CLS = largest session window of shifts (gap < 1s, window < 5s), per web.dev definition.
  let cls = 0;
  let win = 0;
  let winFirst = 0;
  let winLast = 0;
  for (const e of shiftEntries) {
    if (e.hadRecentInput) continue;
    if (win && e.startTime - winLast < 1000 && e.startTime - winFirst < 5000) {
      win += e.value;
    } else {
      win = e.value;
      winFirst = e.startTime;
    }
    winLast = e.startTime;
    cls = Math.max(cls, win);
  }

  const resources = performance.getEntriesByType('resource');
  const kindOf = (r) => {
    const n = r.name.split('?')[0].toLowerCase();
    if (/\.(woff2?|ttf|otf|eot)$/.test(n)) return 'font';
    if (r.initiatorType === 'img' || /\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(n)) return 'image';
    if (r.initiatorType === 'script' || /\.m?js$/.test(n)) return 'script';
    if (/\.css$/.test(n) || r.initiatorType === 'link' || r.initiatorType === 'css') return 'css';
    if (r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest') return 'xhr';
    return 'other';
  };
  const byType = {};
  const sizeByUrl = new Map();
  let transfer = nav ? nav.transferSize || 0 : 0;
  let unknownSize = 0;
  for (const r of resources) {
    const size = r.transferSize || r.encodedBodySize || 0;
    if (!size) unknownSize++;
    transfer += size;
    sizeByUrl.set(r.name, size);
    const k = kindOf(r);
    byType[k] = byType[k] || { count: 0, bytes: 0 };
    byType[k].count++;
    byType[k].bytes += size;
  }

  const perf = {
    ttfb: nav ? Math.round(nav.responseStart - nav.startTime) : null,
    fcp: fcp ? Math.round(fcp.startTime) : null,
    lcp: lcpLast ? Math.round(lcpLast.renderTime || lcpLast.loadTime || lcpLast.startTime) : null,
    lcpElement: lcpLast && lcpLast.element ? describe(lcpLast.element) : null,
    cls: Math.round(cls * 1000) / 1000,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
    htmlBytes: nav ? nav.transferSize || nav.encodedBodySize || 0 : 0,
    protocol: nav ? nav.nextHopProtocol || null : null,
    navigationType: nav ? nav.type : null,
    requests: resources.length + 1,
    transferBytes: transfer,
    unknownSizeCount: unknownSize,
    byType,
    domSize: doc.getElementsByTagName('*').length,
    blockingScripts: [...doc.head.querySelectorAll('script[src]')]
      .filter((s) => !s.async && !s.defer && s.type !== 'module')
      .map((s) => s.src)
      .slice(0, 30),
    headStylesheets: doc.head.querySelectorAll('link[rel~="stylesheet"]:not([media="print"])').length,
  };

  const vh = innerHeight;
  const images = [...doc.images].slice(0, 300).map((img) => {
    const r = img.getBoundingClientRect();
    const src = img.currentSrc || img.src || '';
    return {
      src: src.startsWith('data:') ? 'data:…' : src.slice(0, 300),
      alt: img.getAttribute('alt'),
      decorative: img.getAttribute('role') === 'presentation' || img.getAttribute('role') === 'none' || !!img.closest('[aria-hidden="true"]'),
      loading: img.getAttribute('loading'),
      hasDims: img.hasAttribute('width') && img.hasAttribute('height'),
      natW: img.naturalWidth,
      natH: img.naturalHeight,
      w: Math.round(r.width),
      h: Math.round(r.height),
      belowFold: r.top + scrollY > vh,
      visible: visible(img),
      bytes: sizeByUrl.get(src) || 0,
    };
  });

  // ---------- SEO ----------
  const ldTypes = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (n) => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === 'object') {
          if (n['@type']) ldTypes.push(...[].concat(n['@type']));
          if (n['@graph']) walk(n['@graph']);
        }
      };
      walk(JSON.parse(s.textContent));
    } catch {
      ldTypes.push('(invalid JSON-LD)');
    }
  }
  const bodyText = clean(doc.body ? doc.body.innerText : '');
  const seo = {
    title: doc.title || null,
    description: metaName('description'),
    canonical: doc.querySelector('link[rel="canonical"]')?.href || null,
    robotsMeta: metaName('robots'),
    lang: doc.documentElement.getAttribute('lang'),
    headings: [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0, 150).map((h) => ({
      level: Number(h.tagName[1]),
      text: clip(h.textContent, 100),
    })),
    og: { title: metaProp('og:title'), description: metaProp('og:description'), image: metaProp('og:image') },
    twitterCard: metaName('twitter:card'),
    jsonLd: [...new Set(ldTypes)],
    microdata: doc.querySelectorAll('[itemtype]').length,
    favicon: !!doc.querySelector('link[rel~="icon"], link[rel="shortcut icon"]'),
    appleTouchIcon: !!doc.querySelector('link[rel="apple-touch-icon"]'),
    hreflang: doc.querySelectorAll('link[rel="alternate"][hreflang]').length,
    wordCount: bodyText ? bodyText.split(' ').filter((w) => /\w/.test(w)).length : 0,
  };

  // ---------- links ----------
  const GENERIC = /^(click here|here|read more|more|learn more|link|this|go|details)$/i;
  const internal = new Set();
  const external = new Set();
  const genericText = [];
  const unnamedLinks = [];
  let unsafeBlank = 0;
  let anchorCount = 0;
  const pageNoHash = here.href.split('#')[0];
  for (const a of doc.querySelectorAll('a[href]')) {
    anchorCount++;
    const isVisible = visible(a);
    const name = accName(a);
    if (isVisible && !name) unnamedLinks.push(describe(a));
    if (isVisible && GENERIC.test(name)) genericText.push(`"${name}" → ${a.getAttribute('href').slice(0, 80)}`);
    if (a.target === '_blank' && !/noopener|noreferrer/i.test(a.rel)) unsafeBlank++;
    const raw = a.getAttribute('href').trim();
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|sms|data):/i.test(raw)) continue;
    let u;
    try {
      u = new URL(raw, here);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    u.hash = '';
    if (u.origin === here.origin) {
      if (u.href !== pageNoHash) internal.add(u.href);
    } else external.add(u.href);
  }

  // ---------- accessibility ----------
  const SKIP_TYPES = ['hidden', 'submit', 'button', 'reset', 'image'];
  const fields = [...doc.querySelectorAll('input, select, textarea')].filter(
    (el) => !SKIP_TYPES.includes((el.type || '').toLowerCase()) && visible(el)
  );
  const hasLabel = (el) =>
    (el.id && doc.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
    el.closest('label') ||
    clean(el.getAttribute('aria-label')) ||
    el.getAttribute('aria-labelledby') ||
    clean(el.getAttribute('title'));
  const buttons = [...doc.querySelectorAll('button, [role="button"], input[type="button"]')].filter(visible);
  const idCounts = new Map();
  for (const el of doc.querySelectorAll('[id]')) tally(idCounts, el.id);
  const viewport = metaName('viewport') || '';
  const maxScale = viewport.match(/maximum-scale\s*=\s*([\d.]+)/i);
  const firstLinks = [...doc.querySelectorAll('a[href]')].slice(0, 5);

  const a11y = {
    imagesMissingAlt: images.filter((i) => i.visible && i.alt === null && !i.decorative).map((i) => i.src),
    unlabeledFields: fields.filter((el) => !hasLabel(el)).map(describe).slice(0, 50),
    unnamedButtons: buttons.filter((b) => !accName(b)).map(describe).slice(0, 50),
    unnamedLinks: unnamedLinks.slice(0, 50),
    duplicateIds: [...idCounts.entries()].filter(([, n]) => n > 1).map(([id, n]) => `#${id} (×${n})`).slice(0, 50),
    positiveTabindex: [...doc.querySelectorAll('[tabindex]')].filter((el) => parseInt(el.getAttribute('tabindex'), 10) > 0).map(describe).slice(0, 30),
    hasMain: !!doc.querySelector('main, [role="main"]'),
    hasNav: !!doc.querySelector('nav, [role="navigation"]'),
    untitledIframes: [...doc.querySelectorAll('iframe')]
      .filter((f) => visible(f) && !clean(f.title) && !f.getAttribute('aria-label'))
      .map((f) => (f.src || 'iframe').slice(0, 150)),
    hasSkipLink: firstLinks.some((a) => a.getAttribute('href').startsWith('#') && /skip|main content|jump/i.test(a.textContent)),
    zoomDisabled: /user-scalable\s*=\s*(no|0)/i.test(viewport) || (maxScale ? parseFloat(maxScale[1]) < 2 : false),
    contrastChecked: 0,
    contrastFailures: [],
  };

  // ---------- text pass: contrast, typography, design tokens ----------
  const textEls = new Set();
  if (doc.body) {
    const tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    while (tw.nextNode() && textEls.size < 800) {
      const p = tw.currentNode.parentElement;
      if (p && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|title)$/.test(p.tagName)) textEls.add(p);
    }
  }
  const fonts = new Map();
  const sizes = new Map();
  const colors = new Map();
  let smallText = 0;
  let textSampled = 0;
  for (const el of textEls) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    textSampled++;
    tally(fonts, cs.fontFamily.split(',')[0].replace(/["']/g, '').trim());
    tally(sizes, Math.round(size));
    if (size < 12) smallText++;
    const fg = parseColor(cs.color);
    if (!fg) continue;
    tally(colors, hex(fg));
    const bg = effectiveBg(el);
    if (!bg) continue;
    const a = fg[3];
    const fgOnBg = [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
    const ratio = contrast(fgOnBg, bg);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    a11y.contrastChecked++;
    if (ratio < (large ? 3 : 4.5)) {
      a11y.contrastFailures.push(`${ratio.toFixed(2)}:1 — ${hex(fgOnBg)} on ${hex(bg)} — "${clip(el.textContent, 60)}"`);
    }
  }
  const bgColors = new Map();
  if (doc.body) {
    for (const el of [...doc.body.querySelectorAll('*')].slice(0, 2000)) {
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (c && c[3] > 0.5) tally(bgColors, hex(c));
    }
  }

  // ---------- mobile & UX ----------
  const interactive = [...doc.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]')]
    .filter((el) => !(el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)))
    .filter(visible)
    .slice(0, 600);
  const smallTargets = interactive.filter((el) => {
    if (getComputedStyle(el).display === 'inline') return false; // inline text links are exempt (WCAG 2.5.8)
    const r = el.getBoundingClientRect();
    return r.width < 24 || r.height < 24;
  });
  const mobile = {
    viewport,
    horizontalOverflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1,
    scrollWidth: doc.documentElement.scrollWidth,
    clientWidth: doc.documentElement.clientWidth,
    smallTargets: smallTargets.map(describe).slice(0, 40),
    smallTargetCount: smallTargets.length,
    interactiveCount: interactive.length,
    smallTextRatio: textSampled ? smallText / textSampled : 0,
  };

  // ---------- content (gives the AI review real page copy to work with) ----------
  const mainEl = doc.querySelector('main, [role="main"]') || doc.body;
  const textSample = mainEl
    ? mainEl.innerText.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 6000)
    : '';
  const ctaEls = [...doc.querySelectorAll('a[href], button, input[type="submit"], input[type="button"]')].filter(
    (el) => (el.tagName !== 'A' || /btn|button|cta/i.test(el.className) || el.getAttribute('role') === 'button') && visible(el)
  );
  const SOCIAL = /(^|\.)(facebook|instagram|linkedin|youtube|tiktok|pinterest|twitter|x)\.com$/i;
  const content = {
    textSample,
    navItems: [...new Set([...doc.querySelectorAll('nav a')].map((a) => clip(a.innerText, 40)).filter(Boolean))].slice(0, 15),
    ctas: [...new Set(ctaEls.map((el) => clip(el.innerText || el.value || el.getAttribute('aria-label') || '', 50)).filter(Boolean))].slice(0, 20),
    phoneLinks: doc.querySelectorAll('a[href^="tel:"]').length,
    emailLinks: doc.querySelectorAll('a[href^="mailto:"]').length,
    socialProfiles: [...new Set([...external].map((u) => new URL(u).hostname.replace(/^www\./, '')).filter((h) => SOCIAL.test(h)))].slice(0, 8),
  };

  // ---------- forms ----------
  const forms = [...doc.forms].slice(0, 30).map((f) => {
    const els = [...f.elements].filter(
      (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !SKIP_TYPES.includes((el.type || '').toLowerCase())
    );
    const sig = (el) => `${el.name} ${el.id} ${el.getAttribute('placeholder') || ''}`;
    const action = f.getAttribute('action');
    return {
      name: f.id || f.getAttribute('name') || f.getAttribute('aria-label') || null,
      action: action ? abs(action) : here.href,
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      fields: els.length,
      visible: visible(f),
      isSearch:
        f.getAttribute('role') === 'search' ||
        els.some((el) => el.type === 'search') ||
        (els.length === 1 && /search|^s$|^q$/i.test(els[0].name)),
      hasSubmit: !!f.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]'),
      emailAsText: els.filter((el) => el.type === 'text' && /e-?mail/i.test(sig(el))).length,
      phoneAsText: els.filter((el) => el.type === 'text' && /phone|mobile|\btel\b/i.test(sig(el))).length,
      missingAutocomplete: els.filter(
        (el) => /name|e-?mail|phone|\btel\b|address|city|post.?code|zip|country/i.test(sig(el)) && !el.getAttribute('autocomplete')
      ).length,
      hasPassword: els.some((el) => el.type === 'password'),
      captcha: !!f.querySelector(
        '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]'
      ),
    };
  });

  // ---------- security & technical ----------
  let mixed = [];
  if (here.protocol === 'https:') {
    const attrs = [
      ['img[src]', 'src'],
      ['script[src]', 'src'],
      ['link[rel~="stylesheet"][href]', 'href'],
      ['iframe[src]', 'src'],
      ['video[src]', 'src'],
      ['audio[src]', 'src'],
      ['source[src]', 'src'],
      ['embed[src]', 'src'],
      ['object[data]', 'data'],
    ];
    for (const [sel, attr] of attrs) {
      for (const el of doc.querySelectorAll(sel)) {
        const u = abs(el.getAttribute(attr));
        if (u && u.startsWith('http:')) mixed.push(u);
      }
    }
    for (const r of resources) if (r.name.startsWith('http:')) mixed.push(r.name);
    mixed = [...new Set(mixed)].slice(0, 30);
  }
  const deprecated = {};
  for (const tag of ['font', 'center', 'marquee', 'blink', 'frameset', 'frame', 'big', 'strike', 'tt']) {
    const n = doc.getElementsByTagName(tag).length;
    if (n) deprecated[tag] = n;
  }
  const scriptHosts = new Set();
  for (const s of doc.scripts) {
    try {
      if (s.src) {
        const h = new URL(s.src).hostname;
        if (h !== here.hostname) scriptHosts.add(h);
      }
    } catch {
      /* ignore malformed src */
    }
  }
  const security = {
    protocol: here.protocol,
    mixedContent: mixed,
    deprecatedTags: deprecated,
    doctype: doc.doctype ? doc.doctype.name : null,
    quirksMode: doc.compatMode === 'BackCompat',
    charset: doc.characterSet,
    hasMetaCharset: !!doc.querySelector('meta[charset], meta[http-equiv="content-type" i]'),
    unsafeBlankLinks: unsafeBlank,
    thirdPartyScriptHosts: [...scriptHosts].slice(0, 60),
    inlineScripts: [...doc.scripts].filter((s) => !s.src).length,
  };

  // ---------- technology signals ----------
  let inlineText = '';
  for (const s of doc.scripts) {
    if (!s.src && inlineText.length < 300000) inlineText += s.textContent.slice(0, 50000) + '\n';
  }
  const ids = new Set(inlineText.match(/\b(G-[A-Z0-9]{6,12}|UA-\d{4,10}-\d{1,4}|GTM-[A-Z0-9]{4,9}|AW-\d{6,12})\b/g) || []);
  const classTokens = new Set();
  if (doc.body) {
    for (const el of [...doc.body.querySelectorAll('[class]')].slice(0, 2500)) {
      for (const c of el.classList) classTokens.add(c);
    }
  }
  const tokens = [...classTokens];
  const tech = {
    generator: metaName('generator'),
    scripts: [...doc.scripts].map((s) => s.src).filter(Boolean).slice(0, 200),
    styles: [...doc.querySelectorAll('link[rel~="stylesheet"]')].map((l) => l.href).slice(0, 100),
    iframes: [...doc.querySelectorAll('iframe[src]')].map((f) => f.src).slice(0, 50),
    resourceHosts: [...new Set(resources.map((r) => { try { return new URL(r.name).hostname; } catch { return ''; } }))].filter(Boolean).slice(0, 150),
    trackingIds: [...ids],
    cookieNames: doc.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).slice(0, 80),
    attrs: {
      webflow: doc.documentElement.hasAttribute('data-wf-site'),
      ngVersion: doc.querySelector('[ng-version]')?.getAttribute('ng-version') || null,
      reactRoot: !!doc.querySelector('[data-reactroot]'),
      nextRoot: !!doc.getElementById('__next'),
      nuxtRoot: !!doc.getElementById('__nuxt'),
      svelte: tokens.some((t) => t.startsWith('svelte-')),
      astro: !!doc.querySelector('astro-island, [data-astro-cid]') || tokens.some((t) => t.startsWith('astro-')),
      elementor: tokens.some((t) => t.startsWith('elementor')),
      divi: tokens.some((t) => t.startsWith('et_pb_')),
      yoast: !!doc.querySelector('.yoast-schema-graph'),
      rankMath: !!doc.querySelector('.rank-math-schema, .rank-math-schema-pro'),
      wooCommerce: tokens.some((t) => t.startsWith('woocommerce')),
    },
    bootstrapHits: tokens.filter((t) => /^(container(-fluid)?|row|col(-(sm|md|lg|xl|xxl))?-\d+|btn-(primary|secondary|outline-\w+)|navbar(-\w+)?|d-(none|flex|block)|justify-content-\w+)$/.test(t)).length,
    tailwindHits: tokens.filter((t) => /^(?:[a-z0-9]+:)*-?(?:p[xytrbl]?|m[xytrbl]?|w|h|gap|text|bg|rounded|shadow|grid-cols|flex|items|justify|leading|tracking|font|border)-[a-z0-9./[\]#-]+$/.test(t)).length,
  };

  // ---------- network: headers, robots.txt, sitemap ----------
  let headers = null;
  let robots = null;
  let sitemap = null;
  if (isHttp) {
    try {
      const r = await timedFetch(here.href, { cache: 'no-store', credentials: 'same-origin' });
      headers = { status: r.status, redirected: r.redirected, finalUrl: r.url, map: Object.fromEntries(r.headers.entries()) };
    } catch (e) {
      headers = { error: String(e && e.message ? e.message : e) };
    }

    const sitemapCandidates = [];
    try {
      const r = await timedFetch(here.origin + '/robots.txt', { credentials: 'omit' });
      const text = r.ok ? (await r.text()).slice(0, 20000) : '';
      const isText = r.ok && !/<html/i.test(text.slice(0, 500));
      let agents = [];
      let lastWasAgent = false;
      let blocksAll = false;
      for (const line of text.split(/\r?\n/)) {
        const m = line.replace(/#.*/, '').match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        if (key === 'user-agent') {
          agents = lastWasAgent ? [...agents, m[2]] : [m[2]];
          lastWasAgent = true;
          continue;
        }
        lastWasAgent = false;
        if (key === 'disallow' && m[2] === '/' && agents.includes('*')) blocksAll = true;
        if (key === 'sitemap' && m[2]) sitemapCandidates.push(m[2]);
      }
      robots = { status: r.status, found: isText, blocksAll: isText && blocksAll, sitemaps: sitemapCandidates.slice(0, 10) };
    } catch (e) {
      robots = { status: 0, found: false, error: String(e && e.message ? e.message : e) };
    }

    const tryList = [...sitemapCandidates, here.origin + '/sitemap.xml', here.origin + '/sitemap_index.xml', here.origin + '/wp-sitemap.xml'];
    for (const url of tryList) {
      let u;
      try {
        u = new URL(url, here);
      } catch {
        continue;
      }
      if (u.origin !== here.origin) {
        sitemap = { found: true, url: u.href, verified: false };
        break;
      }
      try {
        const r = await timedFetch(u.href, { credentials: 'omit' });
        const text = r.ok ? (await r.text()).slice(0, 3000) : '';
        if (/<(urlset|sitemapindex)\b/i.test(text)) {
          sitemap = { found: true, url: r.url || u.href, verified: true };
          break;
        }
      } catch {
        /* try next candidate */
      }
    }
    if (!sitemap) sitemap = { found: false };
  }

  return {
    url: here.href,
    title: doc.title,
    viewportSize: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 },
    perf,
    images,
    seo,
    content,
    links: { anchors: anchorCount, internal: [...internal].slice(0, 500), external: [...external].slice(0, 500), genericText: genericText.slice(0, 30), internalCount: internal.size, externalCount: external.size },
    a11y: { ...a11y, contrastFailures: a11y.contrastFailures.slice(0, 40), contrastFailureCount: a11y.contrastFailures.length },
    mobile,
    forms,
    security,
    tech,
    design: { fonts: top(fonts, 8), sizes: top(sizes, 20), colors: top(colors, 12), backgrounds: top(bgColors, 12), fontCount: fonts.size, sizeCount: sizes.size },
    headers,
    robots,
    sitemap,
  };
}

/**
 * Checks a list of URLs and reports their HTTP status. Injected into the page
 * for same-origin links (so no host permission is needed) and called directly
 * from the service worker for external links when the user has granted access.
 * Requests are sent without cookies so checking links never acts as the user.
 */
export async function checkLinks(urls, concurrency = 6) {
  const RISKY = /log-?out|sign-?out|logoff|unsubscribe|delete|remove|cancel|action=/i;
  const timedFetch = async (url, init, ms = 8000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  };
  const check = async (url) => {
    if (RISKY.test(url)) return { url, status: null, skipped: true };
    try {
      const init = { method: 'HEAD', redirect: 'manual', credentials: 'omit', cache: 'no-store' };
      let r = await timedFetch(url, init);
      if ([403, 405, 501].includes(r.status)) r = await timedFetch(url, { ...init, method: 'GET' });
      if (r.type === 'opaqueredirect') return { url, status: 300, redirected: true };
      return { url, status: r.status, redirected: r.status >= 300 && r.status < 400 };
    } catch (e) {
      return { url, status: 0, error: e && e.name === 'AbortError' ? 'Timed out' : 'Request failed' };
    }
  };
  const out = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      out[i] = await check(urls[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

/** Reads JavaScript globals that are only visible in the page's own (MAIN) world. */
export function detectGlobals() {
  const w = window;
  const ver = (v) => (typeof v === 'string' ? v.slice(0, 24) : null);
  const gaIds = [];
  try {
    for (const e of w.dataLayer || []) {
      if (e && e[0] === 'config' && typeof e[1] === 'string') gaIds.push(e[1]);
    }
  } catch {
    /* dataLayer can contain anything */
  }
  try {
    return {
      jquery: ver(w.jQuery && w.jQuery.fn && w.jQuery.fn.jquery),
      react: w.React ? ver(w.React.version) || 'present' : null,
      next: !!w.__NEXT_DATA__ || !!w.next,
      nuxt: !!(w.__NUXT__ || w.$nuxt),
      vue: w.Vue ? ver(w.Vue.version) || 'present' : w.__VUE__ ? 'present' : null,
      gatsby: !!w.___gatsby,
      alpine: w.Alpine ? ver(w.Alpine.version) || 'present' : null,
      htmx: w.htmx ? ver(w.htmx.version) || 'present' : null,
      gsap: w.gsap ? ver(w.gsap.version) || 'present' : null,
      swiper: !!w.Swiper,
      shopify: !!w.Shopify,
      wix: !!w.wixBiSession,
      squarespace: !!(w.Static && w.Static.SQUARESPACE_CONTEXT),
      wp: !!w.wp,
      elementor: w.elementorFrontendConfig ? ver(w.elementorFrontendConfig.version) || 'present' : null,
      woo: !!(w.wc_add_to_cart_params || w.woocommerce_params),
      gtag: typeof w.gtag === 'function',
      ga: typeof w.ga === 'function',
      gtm: !!w.google_tag_manager,
      fbq: typeof w.fbq === 'function',
      hotjar: typeof w.hj === 'function',
      clarity: typeof w.clarity === 'function',
      tiktok: !!w.ttq,
      linkedin: !!w._linkedin_partner_id,
      plausible: typeof w.plausible === 'function',
      matomo: !!w._paq,
      segment: !!(w.analytics && typeof w.analytics.track === 'function'),
      hubspot: !!w._hsq,
      klaviyo: !!(w._learnq || w.klaviyo),
      intercom: typeof w.Intercom === 'function',
      crisp: !!w.$crisp,
      tawk: !!w.Tawk_API,
      gaIds: [...new Set(gaIds)].slice(0, 10),
    };
  } catch {
    return {};
  }
}
