import { getAudit, getSettings, updateAudit, getClientProfile, saveClientProfile, DEFAULT_INTRO, DEFAULT_CTA } from '../src/storage.js';
import {
  CATEGORIES,
  SCORED,
  SEVERITIES,
  SEVERITY_LABEL,
  EFFORT_LABEL,
  PRIORITY_LABEL,
  fmtMs,
  fmtBytes,
} from '../src/analyze.js';
import { esc, toneFor, fmtDate, fmtDateTime, scoreRing, hostOf, applyBrand, logo } from '../shared/ui.js';
import { aiStatus, generateInsights, resolveProvider } from '../src/ai.js';

const app = document.getElementById('app');
const catName = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.name]));
const filters = { category: 'all', severity: 'all' };
let audit;
let settings;
let showStandardSummary = false;
let aiRun = null; // AbortController while insights are being generated
let aiAutoTried = false; // auto-run Chrome built-in AI at most once per page view

init().catch((e) => {
  console.error(e);
  app.innerHTML = `<p class="loading">Could not load this report: ${esc(e.message)}</p>`;
});

async function init() {
  initTheme();
  const id = new URLSearchParams(location.search).get('id');
  [audit, settings] = await Promise.all([getAudit(id), getSettings()]);
  if (!audit) {
    app.innerHTML = '<p class="loading">This report no longer exists. It may have been removed from your history.</p>';
    return;
  }
  applyBrand(settings.brandColor);
  // Reuse the client's name and logo from earlier audits of the same site.
  const profile = await getClientProfile(audit.host);
  const fill = {};
  if (!audit.clientName && profile.name) fill.clientName = profile.name;
  if (audit.clientLogo === undefined && profile.logo) fill.clientLogo = profile.logo;
  if (Object.keys(fill).length) audit = (await updateAudit(audit.id, fill)) || { ...audit, ...fill };
  document.body.classList.toggle('hide-ai-labels', settings.aiLabelsInPdf === false);
  document.title = `Website Audit – ${hostOf(audit.url)} – ${fmtDate(audit.createdAt)}`;
  document.getElementById('toolbar-brand').innerHTML = brandMark();
  render();
  pageFooter();
  document.getElementById('print').addEventListener('click', () => window.print());
  document.getElementById('download').addEventListener('click', downloadPdf);
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);
}

// ───────────────────────── theme ─────────────────────────
function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch {
    /* storage unavailable */
  }
  if (saved) document.documentElement.dataset.theme = saved;
  document.getElementById('theme').addEventListener('click', () => {
    // Dark is the Sitelume default; light is opt-in.
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* storage unavailable */
    }
  });
}

// ───────────────────────── print ─────────────────────────
let openBeforePrint = [];
let filtersBeforePrint = null;
function beforePrint() {
  filtersBeforePrint = { ...filters };
  if (filters.category !== 'all' || filters.severity !== 'all') {
    filters.category = 'all';
    filters.severity = 'all';
    renderIssues();
  }
  openBeforePrint = [...document.querySelectorAll('details')].filter((d) => !d.open);
  openBeforePrint.forEach((d) => (d.open = true));
}
function afterPrint() {
  openBeforePrint.forEach((d) => (d.open = false));
  if (filtersBeforePrint) {
    Object.assign(filters, filtersBeforePrint);
    renderIssues();
  }
}

/**
 * One-click PDF: Chrome renders this tab with the same print CSS as the print
 * dialog (vector text, clickable links), then the file is saved directly.
 * Falls back to the print dialog if the debugger can't attach (e.g. DevTools open).
 */
async function downloadPdf() {
  const btn = document.getElementById('download');
  const label = btn.querySelector('.btn-label');
  if (btn.disabled) return;
  btn.disabled = true;
  label.textContent = 'Preparing PDF…';
  // Commit a client name still being typed on the cover before rendering.
  if (document.activeElement?.id === 'client-name') {
    document.activeElement.blur();
    await new Promise((r) => setTimeout(r, 300));
  }
  let target = null;
  let failed = false;
  try {
    const tab = await chrome.tabs.getCurrent();
    target = { tabId: tab.id };
    await document.fonts.ready;
    beforePrint();
    await chrome.debugger.attach(target, '1.3');
    const { data } = await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      generateTaggedPDF: true,
    });
    saveBlob(base64ToBlob(data, 'application/pdf'), pdfFileName());
  } catch (e) {
    console.warn('Direct PDF download failed, opening the print dialog instead.', e);
    failed = true;
  } finally {
    if (target) await chrome.debugger.detach(target).catch(() => {});
    afterPrint();
    btn.disabled = false;
    label.textContent = 'Download PDF';
  }
  if (failed) {
    alert('Sitelume couldn’t create the PDF directly (close DevTools on this tab if it’s open). Opening the print dialog instead. Choose “Save as PDF” there.');
    window.print();
  }
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** e.g. "Northside Plumbing – Website Audit – 10 Oct 2026.pdf" */
function pdfFileName() {
  const who = (audit.clientName || hostOf(audit.url)).trim();
  return `${who} – Website Audit – ${fmtDate(audit.createdAt)}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
}

// ───────────────────────── render ─────────────────────────
function render() {
  const r = audit.result;
  app.innerHTML = [
    cover(r),
    introNote(r),
    summary(r),
    aiReview(),
    categories(r),
    snapshot(r),
    speed(r),
    comparison(r),
    issuesSection(r),
    actionPlan(r),
    strengths(r),
    appendix(r),
    closing(r),
    footer(),
  ].join('');

  const input = document.getElementById('client-name');
  input.addEventListener('change', async () => {
    const name = input.value.trim();
    audit = (await updateAudit(audit.id, { clientName: name })) || { ...audit, clientName: name };
    await saveClientProfile(audit.host, { name });
    render(); // the intro note greets the client by name
  });
  document.getElementById('client-logo-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const clientLogo = await imageToDataUrl(file, 400);
    audit = (await updateAudit(audit.id, { clientLogo })) || { ...audit, clientLogo };
    await saveClientProfile(audit.host, { logo: clientLogo });
    render();
  });
  document.getElementById('client-logo-remove')?.addEventListener('click', async () => {
    audit = (await updateAudit(audit.id, { clientLogo: null })) || { ...audit, clientLogo: null };
    await saveClientProfile(audit.host, { logo: null });
    render();
  });
  for (const card of app.querySelectorAll('[data-filter-cat]')) {
    card.addEventListener('click', () => {
      filters.category = card.dataset.filterCat;
      filters.severity = 'all';
      renderIssues();
      document.getElementById('issues').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  document.getElementById('summary-toggle')?.addEventListener('click', () => {
    showStandardSummary = !showStandardSummary;
    render();
  });
  renderIssues();
  initAi();
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('ring-animate')));
}

function brandMark() {
  if (settings.logo) return `<img class="brand-logo" src="${esc(settings.logo)}" alt="${esc(settings.agencyName || 'Agency logo')}" />`;
  if (settings.agencyName) return `<span class="brand-name">${esc(settings.agencyName)}</span>`;
  return logo({ height: 26 });
}

function delta(now, before) {
  if (before == null) return '';
  const d = now - before;
  if (d === 0) return '<span class="delta">±0</span>';
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span>`;
}

function cover(r) {
  const prev = audit.previous;
  return `
  <section class="cover card">
    <div class="cover-brand print-only">${brandMark()}</div>
    <div class="cover-main">
      <p class="eyebrow">Website Audit Report</p>
      <h1 class="cover-title">${esc(audit.clientName || hostOf(audit.url))}</h1>
      <a class="cover-url" href="${esc(audit.url)}" target="_blank" rel="noopener">${esc(audit.url)}</a>
      <dl class="cover-meta">
        <div class="client-block${audit.clientName || audit.clientLogo ? '' : ' is-empty'}">
          <dt>Prepared for</dt>
          <dd>
            ${audit.clientLogo ? `<img class="client-logo" src="${esc(audit.clientLogo)}" alt="${esc(audit.clientName || 'Client logo')}" />` : ''}
            <input id="client-name" class="inline-input" value="${esc(audit.clientName || '')}" placeholder="Add client name" aria-label="Prepared for" />
            <span class="client-logo-actions screen-only">
              <label class="mini-btn">${audit.clientLogo ? 'Change logo' : '+ Add client logo'}<input id="client-logo-file" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden /></label>
              ${audit.clientLogo ? '<button id="client-logo-remove" class="mini-btn" type="button">Remove</button>' : ''}
            </span>
          </dd>
        </div>
        ${settings.agencyName ? `<div><dt>Prepared by</dt><dd>${esc(settings.agencyName)}</dd></div>` : ''}
        <div><dt>Date</dt><dd>${esc(fmtDate(audit.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }))}</dd></div>
      </dl>
    </div>
    <div class="cover-score">
      ${scoreRing(r.overall, { size: 176, stroke: 14, label: 'Overall score' })}
      <div class="cover-grade tone-${r.grade.tone}">${esc(r.grade.label)}</div>
      ${prev ? `<div class="muted small">${delta(r.overall, prev.overall)} since ${esc(fmtDate(prev.createdAt))}</div>` : ''}
    </div>
    <ul class="cover-cats">
      ${SCORED.map(
        (c) => `<li>
          <span class="cover-cat-name">${esc(c.name)}</span>
          <span class="cover-cat-bar"><span style="width:${r.scores[c.id]}%;background:var(--${toneFor(r.scores[c.id])})"></span></span>
          <strong class="tone-${toneFor(r.scores[c.id])}">${r.scores[c.id]}</strong>
        </li>`
      ).join('')}
    </ul>
  </section>`;
}

function summary(r) {
  const aiSummary = audit.ai?.summary?.paragraphs;
  const useAi = !!aiSummary && !showStandardSummary;
  const paragraphs = useAi ? aiSummary : r.summary.paragraphs;
  const total = r.issues.length;
  const segs = SEVERITIES.filter((s) => r.counts[s])
    .map((s) => `<span class="stack-seg" style="flex:${r.counts[s]};background:var(--sev-${s})" title="${SEVERITY_LABEL[s]}: ${r.counts[s]}"></span>`)
    .join('');
  return `
  <section class="section">
    <h2>Executive summary</h2>
    <div id="ai-bar" class="ai-bar card screen-only" hidden></div>
    <div class="summary-grid">
      <div class="card pad summary-text">
        ${useAi ? aiLabel('✨ AI-written summary') : ''}
        ${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
        ${aiSummary ? `<button id="summary-toggle" class="link-toggle screen-only" type="button">${useAi ? 'Show standard summary' : 'Show AI summary'}</button>` : ''}
      </div>
      <div class="card pad">
        <div class="stats">
          <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Issues found</div></div>
          <div class="stat"><div class="stat-num">${r.passed.length}</div><div class="stat-label">Checks passed</div></div>
        </div>
        ${total ? `<div class="stack" role="img" aria-label="Issues by severity">${segs}</div>` : ''}
        <ul class="legend">
          ${SEVERITIES.map((s) => `<li><span class="sev sev-${s}">${SEVERITY_LABEL[s]}</span><strong>${r.counts[s]}</strong></li>`).join('')}
        </ul>
      </div>
    </div>
  </section>`;
}

function categories(r) {
  const prev = audit.previous?.scores;
  const cards = SCORED.map((c) => {
    const n = r.issues.filter((i) => i.category === c.id).length;
    return `
    <button class="cat card" type="button" data-filter-cat="${c.id}">
      ${scoreRing(r.scores[c.id], { size: 72, stroke: 7, label: c.name })}
      <div class="cat-text">
        <div class="cat-name">${esc(c.name)} ${prev ? delta(r.scores[c.id], prev[c.id]) : ''}</div>
        <div class="muted small">${esc(c.blurb)}</div>
        <div class="cat-count small">${n ? `${n} issue${n === 1 ? '' : 's'}` : 'No issues'}</div>
      </div>
    </button>`;
  });
  const trackingIssues = r.issues.filter((i) => i.category === 'tracking').length;
  cards.push(`
    <button class="cat card" type="button" data-filter-cat="tracking">
      <div class="cat-icon" aria-hidden="true">${r.tech.length}</div>
      <div class="cat-text">
        <div class="cat-name">Tech Stack &amp; Tracking</div>
        <div class="muted small">${r.tech.length} technolog${r.tech.length === 1 ? 'y' : 'ies'} detected · not scored</div>
        <div class="cat-count small">${trackingIssues ? `${trackingIssues} issue${trackingIssues === 1 ? '' : 's'}` : 'No issues'}</div>
      </div>
    </button>`);
  return `
  <section class="section">
    <h2>Scores by category</h2>
    <div class="cat-grid">${cards.join('')}</div>
  </section>`;
}

function fmtMetric(kind, value) {
  if (value == null) return '—';
  if (kind === 'ms') return fmtMs(value);
  if (kind === 'bytes') return fmtBytes(value);
  if (kind === 'num') return String(value);
  return value.toLocaleString();
}

// Audits saved before PageSpeed support stored one reading per metric as { value, rating }.
function normaliseMetric(m) {
  return 'local' in m ? m : { ...m, local: m.value == null ? null : { value: m.value, rating: m.rating }, lab: null, field: null };
}

const RATING_LABEL = { good: 'Good', average: 'Needs work', poor: 'Poor' };

function readingCell(kind, reading, approx = false) {
  if (!reading) return '<td class="metric-cell muted">—</td>';
  return `<td class="metric-cell">
    <span class="metric-value">${approx ? '≥ ' : ''}${fmtMetric(kind, reading.value)}</span>
    ${reading.rating ? `<span class="badge badge-${reading.rating}">${RATING_LABEL[reading.rating]}</span>` : ''}
  </td>`;
}

function snapshot() {
  const mobileShot = audit.psi?.screenshot;
  return `
  <section class="section snapshot">
    <h2>Snapshot</h2>
    <div class="shots${mobileShot ? ' has-phone' : ''}">
      <figure class="browser card">
        <div class="browser-bar"><span></span><span></span><span></span><div class="browser-url">${esc(hostOf(audit.url))}</div></div>
        ${audit.screenshot ? `<img src="${audit.screenshot}" alt="Desktop screenshot of ${esc(hostOf(audit.url))}" />` : '<div class="no-shot muted">Screenshot unavailable</div>'}
      </figure>
      ${mobileShot ? `<figure class="phone"><img src="${esc(mobileShot)}" alt="Mobile screenshot of ${esc(hostOf(audit.url))}" /></figure>` : ''}
    </div>
  </section>`;
}

function speed(r) {
  const psi = audit.psi;
  const ok = psi && !psi.error && psi.lab;
  const device = psi?.strategy === 'desktop' ? 'Desktop' : 'Mobile';
  const metrics = r.metrics.map(normaliseMetric);
  const cols = [
    { key: 'lab', title: `Google lab test`, sub: `${device}, throttled` },
    { key: 'field', title: 'Real visitors', sub: psi?.field?.scope === 'origin' ? '28 days, whole site' : '28 days, this page' },
    { key: 'local', title: 'Your browser', sub: 'This page load' },
  ].filter((c) => metrics.some((m) => m[c.key]));

  let psiCard = '';
  if (ok && psi.score != null) {
    const f = psi.field;
    const cwv = !f
      ? '<span class="badge badge-none">Not enough data</span>'
      : f.cwvPassed
        ? '<span class="badge badge-good">Passed</span>'
        : '<span class="badge badge-poor">Failed</span>';
    psiCard = `
      <div class="card pad psi-card">
        ${scoreRing(psi.score, { size: 112, stroke: 10, label: 'PageSpeed performance' })}
        <div>
          <div class="psi-title">Google PageSpeed · ${device}</div>
          <p class="muted small">Lighthouse performance score, as shown on pagespeed.web.dev.</p>
          <div class="psi-cwv">Core Web Vitals (real visitors) ${cwv}</div>
        </div>
      </div>`;
  } else if (psi?.error) {
    psiCard = `
      <div class="card pad psi-card psi-error">
        <div>
          <div class="psi-title">Google PageSpeed test unavailable</div>
          <p class="muted small">${esc(psi.error)}</p>
        </div>
      </div>`;
  }

  const opps = ok ? psi.opportunities.filter((o) => o.savingsMs > 0 || o.display).slice(0, 6) : [];
  const oppCard = opps.length
    ? `<div class="card pad">
        <h3 class="h3">Top speed opportunities <span class="muted small">from Google Lighthouse</span></h3>
        <ul class="opps">${opps
          .map((o) => `<li><span>${esc(o.title)}</span><span class="opp-save">${o.savingsMs > 0 ? `≈ ${fmtMs(o.savingsMs)}` : esc(o.display)}</span></li>`)
          .join('')}</ul>
      </div>`
    : '';

  const note = ok
    ? 'Issues in this report use Google’s lab test where available. Real-visitor data comes from the Chrome UX Report (75th percentile) and is what Google uses for rankings.'
    : 'Measured from a single page load in the auditor’s browser, so results vary by device, network and cache.';

  return `
  <section class="section">
    <h2>Speed &amp; Core Web Vitals</h2>
    ${psiCard || oppCard ? `<div class="speed-grid${psiCard && oppCard ? '' : ' single'}">${psiCard}${oppCard}</div>` : ''}
    <div class="card pad metrics-card">
      <div class="table-scroll">
        <table class="table metrics-table">
          <thead><tr><th>Metric</th>${cols.map((c) => `<th>${esc(c.title)}<span class="th-sub">${esc(c.sub)}</span></th>`).join('')}</tr></thead>
          <tbody>
            ${metrics
              .map(
                (m) => `<tr>
                  <td><span class="metric-label">${esc(m.label)}<span class="muted small">Target ${esc(m.target)}</span></span></td>
                  ${cols.map((c) => readingCell(m.kind, m[c.key], c.key === 'local' && m.localApprox && !!m.lab)).join('')}
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <p class="muted small note">${esc(note)}</p>
    </div>
  </section>`;
}

function comparison(r) {
  const prev = audit.previous;
  if (!prev) return '';
  const rows = [...SCORED.map((c) => [c.name, prev.scores?.[c.id], r.scores[c.id]]), ['Overall', prev.overall, r.overall]];
  return `
  <section class="section">
    <h2>Before &amp; after</h2>
    <div class="card pad">
      <p class="muted">Compared with the previous audit of this page on ${esc(fmtDate(prev.createdAt))}.</p>
      <table class="table">
        <thead><tr><th>Category</th><th>Before</th><th>Now</th><th>Change</th></tr></thead>
        <tbody>
          ${rows
            .map(
              ([name, before, now], i) => `
            <tr${i === rows.length - 1 ? ' class="total"' : ''}>
              <td>${esc(name)}</td>
              <td>${before ?? '—'}</td>
              <td><strong class="tone-${toneFor(now)}">${now}</strong></td>
              <td>${delta(now, before)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
  </section>`;
}

function issuesSection(r) {
  return `
  <section class="section" id="issues">
    <h2>Issues &amp; recommendations</h2>
    <div class="filters screen-only" role="toolbar" aria-label="Filter issues">
      <div class="chips" id="cat-chips"></div>
      <div class="chips" id="sev-chips"></div>
    </div>
    <div id="issue-list" class="issue-list"></div>
  </section>`;
}

function renderIssues() {
  const all = audit.result.issues;
  const byCat = all.filter((i) => filters.category === 'all' || i.category === filters.category);
  const shown = byCat.filter((i) => filters.severity === 'all' || i.severity === filters.severity);

  const catChips = [['all', 'All', all.length], ...CATEGORIES.map((c) => [c.id, c.name, all.filter((i) => i.category === c.id).length])];
  const sevChips = [['all', 'Any severity', byCat.length], ...SEVERITIES.map((s) => [s, SEVERITY_LABEL[s], byCat.filter((i) => i.severity === s).length])];
  const chip = (group, [val, label, n]) =>
    `<button class="chip${filters[group] === val ? ' active' : ''}" type="button" data-group="${group}" data-val="${val}" aria-pressed="${filters[group] === val}" ${n === 0 && val !== 'all' ? 'disabled' : ''}>${esc(label)} <span class="chip-n">${n}</span></button>`;
  document.getElementById('cat-chips').innerHTML = catChips.map((c) => chip('category', c)).join('');
  document.getElementById('sev-chips').innerHTML = sevChips.map((c) => chip('severity', c)).join('');
  for (const b of document.querySelectorAll('.chip')) {
    b.addEventListener('click', () => {
      filters[b.dataset.group] = b.dataset.val;
      if (b.dataset.group === 'category') filters.severity = 'all';
      renderIssues();
    });
  }

  document.getElementById('issue-list').innerHTML = shown.length
    ? shown.map(issueCard).join('')
    : `<div class="card pad empty-state">${all.length ? 'No issues match these filters.' : 'No issues found — great work.'}</div>`;
}

function issueCard(i) {
  const more = i.itemCount - i.items.length;
  return `
  <details class="issue card sev-border-${i.severity} prio-${i.priority}">
    <summary>
      <span class="sev sev-${i.severity}">${SEVERITY_LABEL[i.severity]}</span>
      <span class="issue-title">${esc(i.title)}</span>
      <span class="issue-tags">
        <span class="tag">${esc(catName[i.category])}</span>
        <span class="tag tag-p${i.priority}">P${i.priority} · ${PRIORITY_LABEL[i.priority]}</span>
      </span>
      <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </summary>
    <div class="issue-body">
      ${i.detail ? `<p class="issue-detail">${esc(i.detail)}</p>` : ''}
      ${
        audit.ai?.issues?.[i.id]
          ? `${aiBlock(i)}
             <details class="std-more">
               <summary>Standard explanation &amp; fix steps</summary>
               ${standardBlock(i)}
             </details>`
          : standardBlock(i)
      }
      ${
        i.items.length
          ? `<h4>Affected (${i.itemCount})</h4>
             <ul class="items">${i.items.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>
             ${more > 0 ? `<p class="muted small">…and ${more} more.</p>` : ''}`
          : ''
      }
      <div class="issue-foot">
        <span><span class="muted">Effort</span> ${EFFORT_LABEL[i.effort]}</span>
        <span><span class="muted">Priority</span> P${i.priority} · ${PRIORITY_LABEL[i.priority]}</span>
      </div>
    </div>
  </details>`;
}

function standardBlock(i) {
  return `
      <div class="issue-grid">
        <div><h4>Why it matters</h4><p>${esc(i.why)}</p></div>
        <div><h4>Business impact</h4><p>${esc(i.impact)}</p></div>
      </div>
      <h4>How to fix</h4>
      <ol class="fix">${i.fix.map((f) => `<li>${esc(f)}</li>`).join('')}</ol>`;
}

/** AI quick wins + content & conversion review (Gemini only). */
function aiReview() {
  const ai = audit.ai;
  const wins = (ai?.quickWins || []).map((w) => ({ ...w, issue: audit.result.issues.find((i) => i.id === w.id) })).filter((w) => w.issue);
  const review = ai?.contentReview;
  if (!wins.length && !review) return '';
  return `
  <section class="section">
    <h2><span class="lbl-ai">AI review</span><span class="lbl-plain">Quick wins &amp; content review</span></h2>
    ${
      wins.length
        ? `<div class="card pad">
            ${aiLabel('✨ Quick wins', 'Quick wins')}
            <ol class="wins">${wins
              .map(
                (w) => `<li>
                  <p>${esc(w.action)}</p>
                  <span class="tag">${esc(w.issue.title)}</span>
                </li>`
              )
              .join('')}</ol>
          </div>`
        : ''
    }
    ${
      review
        ? `<div class="card pad review">
            ${aiLabel('✨ Content &amp; conversion review', 'Content &amp; conversion review')}
            ${review.verdict ? `<p class="review-verdict">${esc(review.verdict)}</p>` : ''}
            <ul class="review-list">${review.findings
              .map(
                (f) => `<li>
                  <div class="review-area">${esc(f.area)}</div>
                  <div>
                    <p>${esc(f.observation)}</p>
                    <p class="review-suggest"><strong>Suggestion:</strong> ${esc(f.suggestion)}</p>
                  </div>
                </li>`
              )
              .join('')}</ul>
          </div>`
        : ''
    }
  </section>`;
}

function aiBlock(i) {
  const ai = audit.ai?.issues?.[i.id];
  if (!ai) return '';
  return `
      <div class="ai-rec">
        ${aiLabel('✨ AI recommendation for this site', 'Recommendation for this site')}
        <p>${esc(ai.recommendation)}</p>
        <ol class="fix">${ai.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      </div>`;
}

// ───────────────────────── AI insights ─────────────────────────
function aiHelp(provider, model) {
  return provider === 'gemini'
    ? `Uses Google Gemini${model ? ` (${model})` : ''} with your API key. Audit data is sent to Google.`
    : 'Uses Chrome’s built-in AI on this computer. Nothing is sent to a server.';
}

async function initAi() {
  const bar = document.getElementById('ai-bar');
  if (!bar || settings.aiEnabled === false) return;
  if (aiRun) return renderAiBar(aiRun.progress); // keep showing progress across re-renders
  if (audit.aiError && !audit.ai) return renderAiBar({ error: audit.aiError }); // failed during the audit
  const provider = resolveProvider(settings);
  if (provider === 'gemini') return renderAiBar({ status: settings.geminiApiKey ? 'ready' : 'needs-key' });
  const status = await aiStatus();
  // Chrome's model already on this machine: write insights straight away. A first
  // download needs a click (Chrome requires a user gesture), so that still shows a button.
  if (status === 'available' && !audit.ai && !aiAutoTried) {
    aiAutoTried = true;
    return runAi();
  }
  if (status === 'unsupported' || status === 'unavailable') {
    // Don't nag on machines that can't run it; mention it once, quietly.
    if (audit.ai) return renderAiBar({});
    bar.hidden = false;
    bar.innerHTML = `<div class="ai-bar-text"><strong>AI insights</strong><span class="muted small">Chrome’s built-in AI isn’t available on this computer (it needs Chrome 138+ with 16 GB RAM or a 4 GB+ GPU, and 22 GB free disk). Add a free Google Gemini API key in Settings to use AI insights instead.</span></div>
      <a class="btn" href="../options/options.html#ai" target="_blank">Settings</a>`;
    return;
  }
  renderAiBar({ status });
}

function renderAiBar(state = {}) {
  const { status, phase, loaded, done, total, error, model, retry } = state;
  const bar = document.getElementById('ai-bar');
  if (!bar) return;
  if (aiRun) aiRun.progress = state;
  bar.hidden = false;
  const provider = resolveProvider(settings);
  let text;
  let action = '';
  if (aiRun) {
    const step =
      phase === 'download'
        ? `Downloading Chrome’s AI model… ${Math.round((loaded || 0) * 100)}%`
        : phase === 'remote'
          ? retry
            ? `Gemini is busy, retrying with ${esc(model)}…`
            : 'Google Gemini is writing your insights…'
          : phase === 'issues'
            ? `Tailoring recommendations… ${done} of ${total}`
            : 'Writing the executive summary…';
    text = `<strong>${step}</strong><span class="muted small">${aiHelp(provider, model)} This can take a minute.</span>`;
    action = '<button id="ai-cancel" class="btn" type="button">Cancel</button>';
  } else if (error) {
    text = `<strong>AI insights failed</strong><span class="muted small">${esc(error)}</span>`;
    action =
      (provider === 'chrome' ? '<a class="btn" href="../options/options.html#ai" target="_blank">Settings</a>' : '') +
      '<button id="ai-go" class="btn btn-primary" type="button">Try again</button>';
  } else if (audit.ai) {
    const n = Object.keys(audit.ai.issues || {}).length;
    const via = audit.ai.model ? ` Written by ${esc(audit.ai.model)}.` : '';
    text = `<strong>✨ AI insights added</strong><span class="muted small">AI-written summary${n ? ` and ${n} tailored recommendation${n === 1 ? '' : 's'}` : ''}.${via}</span>`;
    action = settings.aiEnabled === false ? '' : '<button id="ai-go" class="btn" type="button">Regenerate</button>';
  } else if (status === 'needs-key') {
    text = `<strong>✨ AI insights</strong><span class="muted small">Add your free Google Gemini API key in Settings to get an AI-written summary and recommendations tailored to this site.</span>`;
    action = '<a class="btn btn-primary" href="../options/options.html#ai" target="_blank">Add API key</a>';
  } else if (status === 'downloadable' || status === 'downloading') {
    text = `<strong>✨ AI insights</strong><span class="muted small">Get an AI-written summary and recommendations tailored to this site. First use downloads Chrome’s AI model (a few GB, one time). ${aiHelp('chrome')}</span>`;
    action = '<button id="ai-go" class="btn btn-primary" type="button">Enable &amp; generate</button>';
  } else {
    text = `<strong>✨ AI insights</strong><span class="muted small">Get an AI-written summary and recommendations tailored to this site. ${aiHelp(provider, provider === 'gemini' ? settings.geminiModel : '')}</span>`;
    action = '<button id="ai-go" class="btn btn-primary" type="button">Generate</button>';
  }
  bar.innerHTML = `<div class="ai-bar-text">${text}</div>${action}`;
  document.getElementById('ai-go')?.addEventListener('click', runAi);
  document.getElementById('ai-cancel')?.addEventListener('click', () => aiRun?.abort());
}

async function runAi() {
  aiRun = new AbortController();
  const provider = resolveProvider(settings);
  renderAiBar({ phase: provider === 'gemini' ? 'remote' : 'summary', model: settings.geminiModel });
  try {
    const ai = await generateInsights(audit, {
      provider,
      apiKey: settings.geminiApiKey,
      model: settings.geminiModel,
      signal: aiRun.signal,
      onProgress: renderAiBar,
    });
    if (!ai.summary && !Object.keys(ai.issues).length) {
      throw new Error('The AI’s answers didn’t match the audit data, so they were discarded. Try again.');
    }
    audit = (await updateAudit(audit.id, { ai, aiError: null })) || { ...audit, ai, aiError: null };
    aiRun = null;
    showStandardSummary = false;
    render();
  } catch (e) {
    const cancelled = e?.name === 'AbortError';
    aiRun = null;
    if (cancelled) return initAi();
    console.warn('AI insights failed:', e?.name, e?.message, e); // shown in the AI bar; warn so Chrome doesn't list it as an extension error
    renderAiBar({ error: e?.message || 'Something went wrong.' });
  }
}

function actionPlan(r) {
  const perWeek = Math.max(1, Number(settings.hoursPerWeek) || 20);
  let cursor = 0;
  const phases = r.phases
    .filter((p) => p.issueCount)
    .map((p) => {
      const weeks = Math.max(1, Math.ceil(p.hours / perWeek));
      const out = { ...p, weeks, start: cursor };
      cursor += weeks;
      return out;
    });
  if (!phases.length) return '';
  const totalWeeks = cursor;
  const totalHours = phases.reduce((n, p) => n + p.hours, 0);
  const rate = Number(settings.hourlyRate) || 0;
  const money = (h) => `${settings.currency || '$'}${(h * rate).toLocaleString()}`;
  const steps = [{ label: 'Today', score: r.overall }, ...phases.map((p) => ({ label: `After phase ${p.priority}`, score: p.projectedOverall }))];

  return `
  <section class="section">
    <h2>Action plan &amp; timeline</h2>
    <div class="phase-grid">
      ${phases
        .map(
          (p) => `
        <article class="phase card pad">
          <div class="phase-num">Phase ${p.priority}</div>
          <h3 class="h3">${esc(p.title)}</h3>
          <p class="muted small">${esc(p.description)}</p>
          <dl class="phase-stats">
            <div><dt>Issues</dt><dd>${p.issueCount}</dd></div>
            <div><dt>Effort</dt><dd>~${p.hours}h</dd></div>
            <div><dt>Duration</dt><dd>${p.weeks} wk${p.weeks === 1 ? '' : 's'}</dd></div>
            ${rate ? `<div><dt>Investment</dt><dd>${money(p.hours)}</dd></div>` : ''}
          </dl>
          <div class="phase-proj">Projected score <strong class="tone-${toneFor(p.projectedOverall)}">${p.projectedOverall}</strong></div>
        </article>`
        )
        .join('')}
    </div>

    <div class="card pad timeline-card">
      <div class="timeline-head">
        <h3 class="h3">Estimated timeline</h3>
        <span class="muted small">${totalHours} hours over ~${totalWeeks} week${totalWeeks === 1 ? '' : 's'} at ${perWeek} h/week${rate ? ` · ${money(totalHours)} total` : ''}</span>
      </div>
      <div class="gantt" style="--weeks:${totalWeeks}">
        <div class="gantt-scale">${Array.from({ length: totalWeeks }, (_, w) => `<span>W${w + 1}</span>`).join('')}</div>
        ${phases
          .map(
            (p) => `
          <div class="gantt-row">
            <span class="gantt-label">Phase ${p.priority}</span>
            <div class="gantt-track"><span class="gantt-bar gantt-p${p.priority}" style="--start:${p.start};--len:${p.weeks}">${p.hours}h</span></div>
          </div>`
          )
          .join('')}
      </div>
      <h3 class="h3 proj-title">Projected score</h3>
      <div class="proj">
        ${steps
          .map(
            (s) => `
          <div class="proj-col">
            <div class="proj-bar-wrap"><div class="proj-bar" style="--h:${s.score}%;background:var(--${toneFor(s.score)})"><span>${s.score}</span></div></div>
            <div class="proj-label small muted">${esc(s.label)}</div>
          </div>`
          )
          .join('')}
      </div>
    </div>
  </section>`;
}

function strengths(r) {
  if (!r.passed.length) return '';
  return `
  <section class="section">
    <h2>What’s working well</h2>
    <div class="card pad">
      <div class="pass-grid">
        ${CATEGORIES.map((c) => {
          const list = r.passed.filter((p) => p.category === c.id);
          if (!list.length) return '';
          return `<div><h4>${esc(c.name)}</h4><ul class="pass-list">${list.map((p) => `<li>${esc(p.title)}</li>`).join('')}</ul></div>`;
        }).join('')}
      </div>
    </div>
  </section>`;
}

function appendix(r) {
  const groups = {};
  for (const t of r.tech) (groups[t.group] = groups[t.group] || []).push(t);
  const raw = audit.raw;
  const byType = Object.entries(raw.perf.byType).sort((a, b) => b[1].bytes - a[1].bytes);
  const linkCount = (audit.links?.internal || []).length;
  const extCount = audit.links?.external ? audit.links.external.length : null;

  return `
  <section class="section appendix">
    <h2>Appendix</h2>

    <div class="card pad">
      <h3 class="h3">Technology stack</h3>
      ${
        r.tech.length
          ? `<div class="tech-grid">${Object.entries(groups)
              .map(
                ([g, list]) => `
            <div><h4>${esc(g)}</h4><div class="tech-chips">${list
              .map((t) => `<span class="tech-chip">${esc(t.name)}${t.version ? ` <span class="muted">${esc(t.version)}</span>` : ''}</span>`)
              .join('')}</div></div>`
              )
              .join('')}</div>`
          : '<p class="muted">No known technologies were detected.</p>'
      }
    </div>

    <div class="card pad">
      <h3 class="h3">Design system</h3>
      <div class="design-grid">
        <div>
          <h4>Typefaces</h4>
          <ul class="font-list">${r.design.fonts.map(([f, n]) => `<li><span style="font-family:'${esc(f)}',var(--font)">${esc(f)}</span><span class="muted small">${n} element${n === 1 ? '' : 's'}</span></li>`).join('') || '<li class="muted">—</li>'}</ul>
        </div>
        <div>
          <h4>Type scale</h4>
          <div class="scale">${r.design.sizes.map(([s]) => `<span>${s}px</span>`).join('')}</div>
        </div>
        <div class="design-colors">
          <h4>Text colours</h4>
          <div class="swatches">${r.design.colors.map(([c]) => swatch(c)).join('')}</div>
          <h4>Background colours</h4>
          <div class="swatches">${r.design.backgrounds.map(([c]) => swatch(c)).join('')}</div>
        </div>
      </div>
    </div>

    <div class="card pad">
      <h3 class="h3">Audit details</h3>
      <table class="table kv">
        <tbody>
          <tr><th>URL</th><td>${esc(audit.url)}</td></tr>
          <tr><th>Audited</th><td>${esc(fmtDateTime(audit.createdAt))}</td></tr>
          <tr><th>Viewport</th><td>${raw.viewportSize.w}×${raw.viewportSize.h} @${raw.viewportSize.dpr}x</td></tr>
          <tr><th>Checks run</th><td>${r.checksRun}</td></tr>
          <tr><th>Links checked</th><td>${linkCount} internal${extCount != null ? `, ${extCount} external` : ' (external links not checked)'}</td></tr>
          <tr><th>HTML elements</th><td>${raw.perf.domSize.toLocaleString()}</td></tr>
          <tr><th>Downloads</th><td>${byType.map(([k, v]) => `${esc(k)} ${fmtBytes(v.bytes)} (${v.count})`).join(' · ') || '—'}</td></tr>
          ${raw.headers?.map?.server ? `<tr><th>Server</th><td>${esc(raw.headers.map.server)}</td></tr>` : ''}
        </tbody>
      </table>
    </div>

    <div class="card pad">
      <h3 class="h3">Methodology &amp; limitations</h3>
      <ul class="method">
        <li>This report audits a single page as loaded in a desktop browser at the time shown above.</li>
        <li>Performance issues use Google PageSpeed Insights (Lighthouse lab test with simulated throttling) when available; otherwise they use one page load in the auditor’s browser, where cached files can make the page appear lighter than it is for first-time visitors.</li>
        <li>Real-visitor data comes from the Chrome UX Report: the 75th percentile of Chrome users over the previous 28 days.</li>
        <li>Scores start at 100 per category and are reduced for each issue according to its severity. The overall score weights Performance 25%, SEO 20%, Accessibility 20%, Security 20% and Mobile &amp; UX 15%.</li>
        <li>Automated accessibility checks catch a subset of WCAG issues. A manual review with assistive technology is recommended for full compliance.</li>
        <li>Security checks are passive — they only read publicly returned headers and page content. No vulnerability scanning was performed.</li>
        <li>Effort estimates are indicative: Small ≈ 2h, Medium ≈ 6h, Large ≈ 2 days.</li>
        ${audit.ai ? `<li class="lbl-ai-line">The executive summary, quick wins, content review and site-specific recommendations were drafted with AI (${esc(audit.ai.model || "AI")}) from the audit data. Findings, scores and priorities come from the automated checks.</li>` : ""}
      </ul>
    </div>
  </section>`;
}

function swatch(c) {
  return `<span class="swatch"><span class="swatch-chip" style="background:${esc(c)}"></span><code>${esc(c)}</code></span>`;
}

// ───────────────────────── client-facing pages ─────────────────────────

/** Badge for AI-written content. In PDFs the agency can swap it for a plain label (or hide it). */
function aiLabel(aiText, plainText = '') {
  return `<div class="ai-badge${plainText ? '' : ' ai-only'}"><span class="lbl-ai">${aiText}</span>${plainText ? `<span class="lbl-plain">${plainText}</span>` : ''}</div>`;
}

function consultantName() {
  return settings.consultantName || settings.agencyName || '';
}

function introNote(r) {
  const from = consultantName();
  if (settings.introEnabled === false) return '';
  if (!from) {
    return `
  <p class="setup-hint screen-only">
    Add your name or agency in <a href="../options/options.html#client-pages" target="_blank">Settings → Client-facing pages</a>
    to include a personal intro note and a closing “next steps” page in this report.
  </p>`;
  }
  const vars = {
    client: audit.clientName || 'there',
    website: hostOf(audit.url),
    score: String(r.overall),
    consultant: from,
    agency: settings.agencyName || from,
  };
  const text = (settings.introNote || DEFAULT_INTRO).replace(/\{(client|website|score|consultant|agency)\}/g, (_, k) => vars[k]);
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return `
  <section class="intro card pad">
    <div class="intro-body">
      ${paragraphs.map((p) => `<p>${esc(p).replace(/\n/g, '<br />')}</p>`).join('')}
    </div>
    ${signature()}
  </section>`;
}

function signature() {
  const name = consultantName();
  const sub = [settings.consultantTitle, settings.consultantName ? settings.agencyName : ''].filter(Boolean).join(', ');
  return `
    <div class="signature">
      ${settings.consultantPhoto ? `<img class="sig-photo" src="${esc(settings.consultantPhoto)}" alt="" />` : ''}
      <div>
        <div class="sig-name">${esc(name)}</div>
        ${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}
      </div>
    </div>`;
}

const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

function qrSvg(url) {
  if (typeof window.qrcode !== 'function') return '';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true, alt: 'QR code to book a call' });
  } catch {
    return '';
  }
}

function closing(r) {
  if (settings.ctaEnabled === false) return '';
  const url = safeUrl(settings.ctaUrl);
  const email = settings.consultantEmail || settings.agencyEmail;
  const phone = settings.consultantPhone;
  const site = settings.agencyWebsite;
  if (!url && !email && !phone && !site) return '';
  const plan = r.phases.filter((p) => p.issueCount);
  const contact = [
    email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : '',
    phone ? `<a href="tel:${esc(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>` : '',
    site ? `<a href="${esc(safeUrl(site) || `https://${site}`)}" target="_blank" rel="noopener">${esc(site.replace(/^https?:\/\//, ''))}</a>` : '',
  ].filter(Boolean);
  return `
  <section class="section closing card">
    <div class="closing-main">
      <p class="eyebrow">Next steps</p>
      <h2 class="closing-title">${esc(settings.ctaHeading || DEFAULT_CTA.heading)}</h2>
      <p class="closing-msg">${esc(settings.ctaMessage || DEFAULT_CTA.message)}</p>
      ${
        plan.length
          ? `<ol class="closing-plan">${plan
              .map(
                (p) => `<li><strong>Phase ${p.priority}</strong> ${esc(p.title)} <span class="muted">· ${p.issueCount} fix${p.issueCount === 1 ? '' : 'es'} · ~${p.hours}h · projected score ${p.projectedOverall}</span></li>`
              )
              .join('')}</ol>`
          : ''
      }
      ${url ? `<a class="btn btn-primary closing-btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(settings.ctaButton || DEFAULT_CTA.button)} →</a>` : ''}
      ${consultantName() || contact.length ? `<div class="closing-contact">${consultantName() ? signature() : ''}${contact.length ? `<div class="contact-links">${contact.join('')}</div>` : ''}</div>` : ''}
    </div>
    ${url && qrSvg(url) ? `<div class="closing-qr"><div class="qr">${qrSvg(url)}</div><span class="muted small">Scan to ${esc((settings.ctaButton || DEFAULT_CTA.button).toLowerCase())}</span></div>` : ''}
  </section>`;
}

/** Reads an uploaded image; raster images are downscaled (PNG keeps transparency). */
async function imageToDataUrl(file, max) {
  if (file.type === 'image/svg+xml') {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

function footer() {
  const bits = [settings.agencyName, settings.agencyWebsite, settings.agencyEmail].filter(Boolean).map(esc);
  return `
  <footer class="report-footer${settings.footerNote || bits.length ? '' : ' print-hide'}">
    ${settings.footerNote ? `<p>${esc(settings.footerNote)}</p>` : ''}
    ${bits.length ? `<p class="muted">${bits.join(' · ')}</p>` : ''}
    <p class="muted small generated">Generated ${esc(fmtDate(audit.createdAt))}</p>
  </footer>`;
}

/** PDF running footer on every page after the cover: report name left, page numbers right. */
function pageFooter() {
  const cssStr = (s) => `"${String(s).replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;
  const left = [settings.agencyName, `Website audit · ${hostOf(audit.url)}`, fmtDate(audit.createdAt)].filter(Boolean).join('  ·  ');
  const box = 'font-family: Inter, system-ui, sans-serif; font-size: 8pt; color: #71717a;';
  let el = document.getElementById('page-footer');
  if (!el) {
    el = document.createElement('style');
    el.id = 'page-footer';
    document.head.append(el);
  }
  el.textContent = `
    @page {
      @bottom-left { content: ${cssStr(left)}; ${box} }
      @bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} }
    }
    @page :first {
      @bottom-left { content: none; }
      @bottom-right { content: none; }
    }`;
}

