/**
 * Service worker: runs audits so they keep going even if the popup closes.
 *
 * Messages in:  { type: 'run-audit', tabId }  |  { type: 'audit-status' }
 * Messages out: { type: 'audit-progress', status } broadcast to any open popup.
 */
import { collectPage, checkLinks, detectGlobals } from './collector.js';
import { analyze } from './analyze.js';
import { getSettings, saveAudit, findPreviousAudit } from './storage.js';
import { runPsi } from './psi.js';
import { generateInsights, resolveProvider } from './ai.js';

const STEPS = {
  screenshot: 'Capturing screenshot',
  collect: 'Analysing page',
  links: 'Checking links',
  psi: 'Running Google PageSpeed test',
  score: 'Scoring results',
  ai: 'Writing AI insights',
};

let status = { running: false, step: null, label: null, error: null, tabId: null };

function setStatus(patch) {
  status = { ...status, ...patch };
  chrome.storage.session.set({ auditStatus: status }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'audit-progress', status }).catch(() => {}); // no popup open is fine
}

// First install: open the welcome page so the user can add API keys before auditing.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/welcome.html') });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'audit-status') {
    sendResponse(status);
    return;
  }
  if (msg?.type === 'run-audit') {
    if (status.running) {
      sendResponse({ ok: false, error: 'An audit is already running.' });
      return;
    }
    setStatus({ running: true, step: 'screenshot', label: STEPS.screenshot, error: null, tabId: msg.tabId });
    runAudit(msg.tabId)
      .then(() => setStatus({ running: false, step: 'done', label: 'Done' }))
      .catch((e) => {
        console.error('Audit failed', e);
        setStatus({ running: false, step: 'error', label: null, error: friendlyError(e) });
      });
    sendResponse({ ok: true });
  }
});

function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/cannot be scripted|cannot access|chrome:\/\/|extensions gallery|Missing host permission/i.test(msg)) {
    return 'Chrome does not allow extensions to read this page. Open a regular website and try again.';
  }
  return msg;
}

async function inject(tabId, func, args = [], world = 'ISOLATED') {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  if (!res || res.result === undefined || res.result === null) {
    throw new Error(res?.error?.message || 'Could not read the page. Reload it and try again.');
  }
  return res.result;
}

async function runAudit(tabId) {
  const started = Date.now();
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || '')) {
    throw new Error('Only http:// and https:// pages can be audited.');
  }
  const settings = await getSettings();

  // Google's test takes 15–60s, so start it now and collect the result at the end.
  const psiPromise = settings.psiEnabled
    ? runPsi(tab.url, { key: settings.psiApiKey, strategy: settings.psiStrategy })
    : Promise.resolve(null);

  // Screenshot first, while the tab is guaranteed to be visible.
  let screenshot = null;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 72 });
  } catch (e) {
    console.warn('Screenshot failed', e);
  }

  setStatus({ step: 'collect', label: STEPS.collect });
  const [raw, globals] = await Promise.all([
    inject(tabId, collectPage),
    inject(tabId, detectGlobals, [], 'MAIN').catch(() => ({})),
  ]);

  setStatus({ step: 'links', label: STEPS.links });
  const maxLinks = Math.max(0, Number(settings.maxLinks) || 0);
  const internalLinks = maxLinks ? await inject(tabId, checkLinks, [raw.links.internal.slice(0, maxLinks)]) : [];
  let externalLinks = null;
  if (settings.checkExternal && (await chrome.permissions.contains({ origins: ['<all_urls>'] }))) {
    externalLinks = await checkLinks(raw.links.external.slice(0, 30));
  }

  setStatus({ step: 'psi', label: STEPS.psi });
  const psi = await psiPromise;

  setStatus({ step: 'score', label: STEPS.score });
  const result = analyze({ raw, globals, internalLinks, externalLinks, psi });
  const url = new URL(raw.url);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const previous = await findPreviousAudit(raw.url, id);
  const audit = {
    id,
    url: raw.url,
    host: url.hostname,
    title: raw.title || url.hostname,
    createdAt: new Date().toISOString(),
    clientName: '',
    screenshot,
    previous,
    raw,
    globals,
    links: { internal: internalLinks, external: externalLinks },
    psi,
    result,
  };

  // With a Gemini key, AI insights are part of the audit itself. (Chrome's
  // built-in model isn't available in service workers; the report runs it.)
  if (settings.aiEnabled !== false && settings.geminiApiKey && resolveProvider(settings) === 'gemini') {
    setStatus({ step: 'ai', label: STEPS.ai });
    try {
      const ai = await generateInsights(audit, { provider: 'gemini', apiKey: settings.geminiApiKey, model: settings.geminiModel });
      if (ai.summary || Object.keys(ai.issues).length) audit.ai = ai;
      else audit.aiError = 'The AI’s answers didn’t match the audit data, so they were discarded. Try again.';
    } catch (e) {
      audit.aiError = e?.message || 'AI insights failed.';
    }
  }

  await saveAudit({ ...audit, durationMs: Date.now() - started });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`report/report.html?id=${id}`),
    index: tab.index + 1,
    openerTabId: tabId,
  });
}
