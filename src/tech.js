/**
 * Technology fingerprinting from signals gathered by collectPage() and
 * detectGlobals(). Each signature returns true, a version string, or a falsy value.
 */

const SIGNATURES = [
  // CMS & site builders
  { name: 'WordPress', group: 'CMS', test: (c) => c.gen(/wordpress\s*([\d.]+)?/i) || c.url(/\/wp-(content|includes)\//) || c.g.wp },
  { name: 'Shopify', group: 'CMS', test: (c) => c.g.shopify || c.url(/cdn\.shopify\.com|myshopify\.com/) },
  { name: 'Wix', group: 'CMS', test: (c) => c.g.wix || c.url(/static\.wixstatic\.com|parastorage\.com/) || c.gen(/wix\.com/i) },
  { name: 'Squarespace', group: 'CMS', test: (c) => c.g.squarespace || c.url(/squarespace(-cdn)?\.com/) },
  { name: 'Webflow', group: 'CMS', test: (c) => c.a.webflow || c.url(/website-files\.com|webflow\.com/) || c.gen(/webflow/i) },
  { name: 'Drupal', group: 'CMS', test: (c) => c.gen(/drupal\s*([\d.]+)?/i) || c.url(/\/sites\/(default|all)\/|drupal\.js/) },
  { name: 'Joomla', group: 'CMS', test: (c) => c.gen(/joomla!?\s*([\d.]+)?/i) || c.url(/\/media\/(jui|system)\/js\//) },
  { name: 'Magento', group: 'CMS', test: (c) => c.url(/\/static\/version\d+\/|mage\/cookies/) },
  { name: 'Ghost', group: 'CMS', test: (c) => c.gen(/ghost\s*([\d.]+)?/i) },
  { name: 'HubSpot CMS', group: 'CMS', test: (c) => c.gen(/hubspot/i) || c.url(/hubspot(usercontent)?-?\w*\.(net|com)\/hub\//) },
  { name: 'Framer', group: 'CMS', test: (c) => c.url(/framerusercontent\.com|framer\.com\/m\//) || c.gen(/framer/i) },

  // CMS add-ons
  { name: 'Elementor', group: 'Page builder', test: (c) => c.g.elementor || c.a.elementor || c.url(/\/elementor\//) },
  { name: 'Divi', group: 'Page builder', test: (c) => c.a.divi || c.url(/\/Divi\//) },
  { name: 'WooCommerce', group: 'Ecommerce', test: (c) => c.g.woo || c.a.wooCommerce || c.url(/\/woocommerce\//) },
  { name: 'Yoast SEO', group: 'SEO', test: (c) => c.a.yoast },
  { name: 'Rank Math', group: 'SEO', test: (c) => c.a.rankMath },

  // JavaScript frameworks & libraries
  { name: 'Next.js', group: 'JavaScript framework', test: (c) => c.g.next || c.a.nextRoot || c.url(/\/_next\/static\//) },
  { name: 'Nuxt', group: 'JavaScript framework', test: (c) => c.g.nuxt || c.a.nuxtRoot || c.url(/\/_nuxt\//) },
  { name: 'React', group: 'JavaScript framework', test: (c) => verOrTrue(c.g.react) || c.a.reactRoot || c.g.next },
  { name: 'Vue.js', group: 'JavaScript framework', test: (c) => verOrTrue(c.g.vue) || c.g.nuxt },
  { name: 'Angular', group: 'JavaScript framework', test: (c) => c.a.ngVersion },
  { name: 'Svelte', group: 'JavaScript framework', test: (c) => c.a.svelte || c.url(/\/_app\/immutable\//) },
  { name: 'Astro', group: 'JavaScript framework', test: (c) => c.a.astro || c.gen(/astro\s*v?([\d.]+)?/i) },
  { name: 'Gatsby', group: 'JavaScript framework', test: (c) => c.g.gatsby || c.gen(/gatsby\s*([\d.]+)?/i) },
  { name: 'Alpine.js', group: 'JavaScript library', test: (c) => verOrTrue(c.g.alpine) },
  { name: 'htmx', group: 'JavaScript library', test: (c) => verOrTrue(c.g.htmx) },
  { name: 'jQuery', group: 'JavaScript library', test: (c) => jqueryVersion(c) },
  { name: 'GSAP', group: 'JavaScript library', test: (c) => verOrTrue(c.g.gsap) || c.url(/gsap(\.min)?\.js/) },
  { name: 'Swiper', group: 'JavaScript library', test: (c) => c.g.swiper || c.url(/swiper/i) },

  // CSS & fonts
  { name: 'Bootstrap', group: 'CSS framework', test: (c) => c.raw.tech.bootstrapHits >= 8 || c.url(/bootstrap(\.min)?\.(css|js)/) },
  { name: 'Tailwind CSS', group: 'CSS framework', test: (c) => c.raw.tech.tailwindHits >= 40 },
  { name: 'Google Fonts', group: 'Fonts', test: (c) => c.url(/fonts\.(googleapis|gstatic)\.com/) },
  { name: 'Adobe Fonts', group: 'Fonts', test: (c) => c.url(/use\.typekit\.net|p\.typekit\.net/) },
  { name: 'Font Awesome', group: 'Fonts', test: (c) => c.url(/font-?awesome|kit\.fontawesome\.com/i) },

  // Analytics
  { name: 'Google Analytics 4', group: 'Analytics', analytics: true, test: (c) => c.id(/^G-/) || c.url(/gtag\/js\?id=G-/) || c.g.gaIds?.some((i) => i.startsWith('G-')) },
  { name: 'Universal Analytics', group: 'Analytics', analytics: true, legacy: true, test: (c) => c.id(/^UA-/) || c.url(/google-analytics\.com\/analytics\.js/) || c.g.gaIds?.some((i) => i.startsWith('UA-')) },
  { name: 'Google Tag Manager', group: 'Tag manager', test: (c) => c.g.gtm || c.id(/^GTM-/) || c.url(/googletagmanager\.com\/gtm\.js/) },
  { name: 'Plausible', group: 'Analytics', analytics: true, test: (c) => c.g.plausible || c.url(/plausible\.io/) },
  { name: 'Matomo', group: 'Analytics', analytics: true, test: (c) => c.g.matomo || c.url(/matomo|piwik/) },
  { name: 'Fathom', group: 'Analytics', analytics: true, test: (c) => c.url(/usefathom\.com/) },
  { name: 'Segment', group: 'Analytics', analytics: true, test: (c) => c.g.segment || c.url(/cdn\.segment\.com/) },
  { name: 'Hotjar', group: 'Analytics', analytics: true, marketing: true, test: (c) => c.g.hotjar || c.url(/static\.hotjar\.com/) || c.cookie(/^_hj/) },
  { name: 'Microsoft Clarity', group: 'Analytics', analytics: true, marketing: true, test: (c) => c.g.clarity || c.url(/clarity\.ms/) || c.cookie(/^_clck$/) },

  // Advertising pixels
  { name: 'Google Ads', group: 'Advertising', marketing: true, test: (c) => c.id(/^AW-/) || c.cookie(/^_gcl_au$/) || c.url(/googleadservices\.com|googlesyndication\.com/) },
  { name: 'Meta Pixel', group: 'Advertising', marketing: true, test: (c) => c.g.fbq || c.url(/connect\.facebook\.net/) || c.cookie(/^_fbp$/) },
  { name: 'LinkedIn Insight', group: 'Advertising', marketing: true, test: (c) => c.g.linkedin || c.url(/snap\.licdn\.com/) },
  { name: 'TikTok Pixel', group: 'Advertising', marketing: true, test: (c) => c.g.tiktok || c.url(/analytics\.tiktok\.com/) },

  // Marketing & chat
  { name: 'HubSpot', group: 'Marketing', marketing: true, test: (c) => c.g.hubspot || c.url(/js\.hs-scripts\.com|js\.hsforms\.net/) },
  { name: 'Klaviyo', group: 'Marketing', marketing: true, test: (c) => c.g.klaviyo || c.url(/klaviyo\.com/) },
  { name: 'Mailchimp', group: 'Marketing', test: (c) => c.url(/chimpstatic\.com|list-manage\.com/) },
  { name: 'Intercom', group: 'Live chat', test: (c) => c.g.intercom || c.url(/widget\.intercom\.io/) },
  { name: 'Crisp', group: 'Live chat', test: (c) => c.g.crisp || c.url(/client\.crisp\.chat/) },
  { name: 'Tawk.to', group: 'Live chat', test: (c) => c.g.tawk || c.url(/embed\.tawk\.to/) },
  { name: 'Zendesk', group: 'Live chat', test: (c) => c.url(/static\.zdassets\.com/) },

  // Consent
  { name: 'Cookiebot', group: 'Consent', consent: true, test: (c) => c.url(/cookiebot\.com/) },
  { name: 'OneTrust', group: 'Consent', consent: true, test: (c) => c.url(/cookielaw\.org|onetrust\.com/) },
  { name: 'CookieYes', group: 'Consent', consent: true, test: (c) => c.url(/cookieyes\.com|cookie-law-info/) },
  { name: 'Complianz', group: 'Consent', consent: true, test: (c) => c.url(/complianz/) || c.cookie(/^cmplz_/) },
  { name: 'Termly', group: 'Consent', consent: true, test: (c) => c.url(/termly\.io/) },
  { name: 'iubenda', group: 'Consent', consent: true, test: (c) => c.url(/iubenda\.com/) },
  { name: 'Usercentrics', group: 'Consent', consent: true, test: (c) => c.url(/usercentrics\.eu/) },
  { name: 'Osano', group: 'Consent', consent: true, test: (c) => c.url(/osano\.com/) },
  { name: 'CookieScript', group: 'Consent', consent: true, test: (c) => c.url(/cookie-script\.com/) },
  { name: 'Borlabs Cookie', group: 'Consent', consent: true, test: (c) => c.url(/borlabs-cookie/) || c.cookie(/^borlabs-cookie/) },
  { name: 'Didomi', group: 'Consent', consent: true, test: (c) => c.url(/didomi\.io/) },

  // Bot protection
  { name: 'reCAPTCHA', group: 'Bot protection', test: (c) => c.url(/recaptcha/) },
  { name: 'hCaptcha', group: 'Bot protection', test: (c) => c.url(/hcaptcha\.com/) },
  { name: 'Cloudflare Turnstile', group: 'Bot protection', test: (c) => c.url(/challenges\.cloudflare\.com\/turnstile/) },

  // Hosting, CDN & servers (from response headers)
  { name: 'Cloudflare', group: 'Hosting & CDN', test: (c) => c.h('cf-ray') || /cloudflare/i.test(c.h('server')) },
  { name: 'Vercel', group: 'Hosting & CDN', test: (c) => c.h('x-vercel-id') || /vercel/i.test(c.h('server')) },
  { name: 'Netlify', group: 'Hosting & CDN', test: (c) => c.h('x-nf-request-id') || /netlify/i.test(c.h('server')) },
  { name: 'Amazon CloudFront', group: 'Hosting & CDN', test: (c) => c.h('x-amz-cf-id') },
  { name: 'Fastly', group: 'Hosting & CDN', test: (c) => /fastly/i.test(c.h('x-served-by') + c.h('via')) || c.h('x-fastly-request-id') },
  { name: 'Akamai', group: 'Hosting & CDN', test: (c) => /akamai/i.test(c.h('server')) },
  { name: 'Kinsta', group: 'Hosting & CDN', test: (c) => c.h('x-kinsta-cache') },
  { name: 'WP Engine', group: 'Hosting & CDN', test: (c) => c.h('wpe-backend') || c.h('x-wpe-loopback-upstream-addr') },
  { name: 'LiteSpeed', group: 'Web server', test: (c) => /litespeed/i.test(c.h('server')) || c.h('x-litespeed-cache') },
  { name: 'Nginx', group: 'Web server', test: (c) => serverVersion(c, /nginx\/?([\d.]+)?/i) },
  { name: 'Apache', group: 'Web server', test: (c) => serverVersion(c, /apache\/?([\d.]+)?/i) },
  { name: 'Microsoft IIS', group: 'Web server', test: (c) => serverVersion(c, /microsoft-iis\/?([\d.]+)?/i) },
  { name: 'PHP', group: 'Language', test: (c) => serverVersion(c, /php\/?([\d.]+)?/i, 'x-powered-by') },
];

function verOrTrue(v) {
  if (!v) return false;
  return v === 'present' ? true : v;
}

function serverVersion(c, re, header = 'server') {
  const m = c.h(header).match(re);
  return m ? m[1] || true : false;
}

export function jqueryVersion(c) {
  if (c.g.jquery) return c.g.jquery;
  for (const s of c.raw.tech.scripts) {
    const m = s.match(/\/jquery(?:\.min)?\.js\?ver=([\d.]+)/) || s.match(/\/jquery[-.](\d+\.\d+\.\d+)(?:\.min)?\.js/);
    if (m) return m[1];
  }
  return c.raw.tech.scripts.some((s) => /\/jquery(\.min)?\.js/.test(s));
}

export function detectTechnologies(raw, globals = {}) {
  const t = raw.tech;
  const haystack = [...t.scripts, ...t.styles, ...t.iframes, ...t.resourceHosts].join('\n');
  const headers = raw.headers?.map || {};
  const ctx = {
    raw,
    g: globals,
    a: t.attrs || {},
    url: (re) => re.test(haystack),
    id: (re) => t.trackingIds.some((i) => re.test(i)),
    cookie: (re) => t.cookieNames.some((n) => re.test(n)),
    h: (name) => headers[name] || '',
    gen: (re) => {
      const m = t.generator && t.generator.match(re);
      return m ? m[1] || true : false;
    },
  };
  const found = [];
  for (const sig of SIGNATURES) {
    let r = false;
    try {
      r = sig.test(ctx);
    } catch {
      r = false;
    }
    // Only version-like strings count as versions (header-based tests can return IDs such as cf-ray).
    const version = typeof r === 'string' && /^v?\d+(\.\d+)*([-+.][\w.]+)?$/i.test(r.trim()) ? r.trim().replace(/^v/i, '') : null;
    if (r) found.push({ name: sig.name, group: sig.group, version, analytics: !!sig.analytics, marketing: !!sig.marketing, consent: !!sig.consent, legacy: !!sig.legacy });
  }
  return found;
}

/** Returns true when version a < version b (dotted numeric). */
export function versionLt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}
