/** Small DOM/formatting helpers shared by the extension pages. */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const toneFor = (score) => (score >= 75 ? 'good' : score >= 50 ? 'average' : 'poor');

export const fmtDate = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(iso).toLocaleDateString(undefined, opts);

export const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Circular score gauge. The arc animates in when `.ring-animate` is added to an ancestor.
 * Colour follows the score tone; the number is centred inside.
 */
export function scoreRing(score, { size = 120, stroke = 10, label = '' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  const tone = toneFor(score);
  return `
    <svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label || 'Score')} ${score} out of 100">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:var(--surface-2)" stroke-width="${stroke}"/>
      <circle class="ring-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}" style="stroke:var(--${tone});--ring-c:${c};--ring-o:${offset}"
        transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" style="fill:var(--text);font-family:var(--font)"
        font-size="${Math.round(size * 0.3)}" font-weight="700">${score}</text>
    </svg>`;
}

/**
 * Applies a brand colour as the page accent and picks black or white text for
 * use on top of it, whichever has the higher WCAG contrast.
 */
export function applyBrand(color, root = document.documentElement) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return;
  const n = parseInt(m[1], 16);
  const lin = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const onWhite = 1.05 / (lum + 0.05);
  const onBlack = (lum + 0.05) / 0.05;
  root.style.setProperty('--accent', `#${m[1]}`);
  root.style.setProperty('--accent-ink', onWhite >= onBlack ? '#ffffff' : '#09090b');
}

/**
 * Sitelume logo lockup: the mark in both colour versions (CSS shows the one that
 * suits the current theme, see .logo in theme.css) plus the name in type.
 * `height` is the mark's height in px. Paths are relative to a page one folder
 * deep (popup/, report/, options/). Keep in sync with the static copies in
 * popup.html, options.html and welcome.html.
 */
export function logo({ height = 26 } = {}) {
  return `<span class="logo" style="font-size:${Math.round(height * 0.8)}px">
    <img class="logo-on-dark" src="../assets/brand/sitelume-mark-on-dark.png" alt="" />
    <img class="logo-on-light" src="../assets/brand/sitelume-mark-on-light.png" alt="" />
    <span>Site<span class="logo-lume">lume</span></span>
  </span>`;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
