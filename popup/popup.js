import { getSettings, saveSettings, listAudits } from '../src/storage.js';
import { esc, toneFor, fmtDateTime, hostOf, applyBrand } from '../shared/ui.js';

const $ = (id) => document.getElementById(id);
const STEP_ORDER = ['screenshot', 'collect', 'links', 'psi', 'score', 'ai'];
let tab = null;

init();

async function init() {
  const [settings, [activeTab], audits, status] = await Promise.all([
    getSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
    listAudits(),
    chrome.runtime.sendMessage({ type: 'audit-status' }).catch(() => null),
  ]);
  tab = activeTab;
  applyBrand(settings.brandColor);

  // First run: ask for API keys before showing the audit controls (users can skip).
  const needsSetup = !settings.setupDone && !(settings.geminiApiKey && settings.psiApiKey) && !status?.running;
  $('setup-ui').hidden = !needsSetup;
  $('main-ui').hidden = needsSetup;
  $('setup-go').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/welcome.html') });
    window.close();
  });
  $('setup-skip').addEventListener('click', async () => {
    await saveSettings({ setupDone: true, setupSkipped: true });
    $('setup-ui').hidden = true;
    $('main-ui').hidden = false;
  });

  renderSite();
  renderRecent(audits);
  $('external').checked = settings.checkExternal;
  if (status) renderStatus(status);

  $('run').addEventListener('click', run);
  $('external').addEventListener('change', toggleExternal);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'audit-progress') renderStatus(msg.status);
  });
}

function renderSite() {
  const auditable = tab && /^https?:/i.test(tab.url || '');
  $('site-title').textContent = tab?.title || 'No page';
  $('site-title').title = tab?.title || '';
  $('site-host').textContent = auditable ? hostOf(tab.url) : 'This page can’t be audited';
  if (tab?.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl)) $('favicon').src = tab.favIconUrl;
  else $('favicon').style.visibility = 'hidden';
  $('run').disabled = !auditable;
}

async function run() {
  showError(null);
  const res = await chrome.runtime.sendMessage({ type: 'run-audit', tabId: tab.id });
  if (!res?.ok) showError(res?.error || 'Could not start the audit.');
}

function renderStatus(status) {
  const btn = $('run');
  const list = $('progress');
  if (status.running) {
    btn.disabled = true;
    btn.classList.add('is-running');
    btn.textContent = status.label || 'Auditing…';
    list.hidden = false;
    const current = STEP_ORDER.indexOf(status.step);
    for (const li of list.children) {
      const i = STEP_ORDER.indexOf(li.dataset.step);
      li.classList.toggle('done', i < current);
      li.classList.toggle('active', i === current);
    }
    return;
  }
  btn.classList.remove('is-running');
  btn.textContent = 'Run audit';
  btn.disabled = !(tab && /^https?:/i.test(tab.url || ''));
  list.hidden = true;
  if (status.step === 'error') showError(status.error);
  if (status.step === 'done') listAudits().then(renderRecent);
}

function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg || '';
}

async function toggleExternal(e) {
  if (!e.target.checked) {
    await saveSettings({ checkExternal: false });
    return;
  }
  // Must be called directly from the click to count as a user gesture.
  const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
  e.target.checked = granted;
  await saveSettings({ checkExternal: granted });
}

function renderRecent(audits) {
  const items = audits.slice(0, 5);
  $('recent-empty').hidden = items.length > 0;
  $('recent-list').innerHTML = items
    .map(
      (a) => `
      <li>
        <a href="#" data-id="${esc(a.id)}">
          <span class="pill tone-${toneFor(a.overall)}">${a.overall}</span>
          <span class="recent-meta">
            <span class="recent-host">${esc(hostOf(a.url))}${new URL(a.url).pathname !== '/' ? `<span class="muted">${esc(new URL(a.url).pathname)}</span>` : ''}</span>
            <span class="recent-date">${esc(fmtDateTime(a.createdAt))}</span>
          </span>
        </a>
      </li>`
    )
    .join('');
  for (const a of $('recent-list').querySelectorAll('a')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${a.dataset.id}`) });
    });
  }
}
