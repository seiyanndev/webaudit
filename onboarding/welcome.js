import { getSettings, saveSettings } from '../src/storage.js';
import { applyBrand } from '../shared/ui.js';
import { checkGeminiKey, checkPsiKey } from '../src/keys.js';

const $ = (id) => document.getElementById(id);
const fields = {
  gemini: { input: $('gemini'), status: $('gemini-status'), check: checkGeminiKey, result: null, checked: '' },
  psi: { input: $('psi'), status: $('psi-status'), check: checkPsiKey, result: null, checked: '' },
};
const timers = {};

init();

async function init() {
  const s = await getSettings();
  applyBrand(s.brandColor);
  fields.gemini.input.value = s.geminiApiKey || '';
  fields.psi.input.value = s.psiApiKey || '';
  for (const [name, f] of Object.entries(fields)) {
    if (f.input.value) validate(name);
    f.input.addEventListener('input', () => {
      clearTimeout(timers[name]);
      f.result = null;
      showStatus(name, f.input.value.trim() ? { busy: true, message: 'Checking…' } : null);
      if (f.input.value.trim()) timers[name] = setTimeout(() => validate(name), 600);
      updateSaveLabel();
    });
  }
  $('form').addEventListener('submit', onSave);
  $('skip').addEventListener('click', onSkip);
  updateSaveLabel();
}

async function validate(name) {
  const f = fields[name];
  const value = f.input.value.trim();
  if (!value) return null;
  if (f.result && f.checked === value) return f.result;
  showStatus(name, { busy: true, message: 'Checking…' });
  const result = await f.check(value);
  if (f.input.value.trim() !== value) return null; // edited while checking
  f.result = result;
  f.checked = value;
  showStatus(name, result);
  return result;
}

function showStatus(name, r) {
  const f = fields[name];
  const field = f.input.closest('.field');
  field.classList.toggle('is-ok', !!r?.ok);
  field.classList.toggle('is-bad', !!r && !r.ok && !r.busy);
  f.status.className = `status ${r ? (r.busy ? 'busy' : r.ok ? 'ok' : 'bad') : ''}`;
  f.status.textContent = r ? `${r.busy ? '' : r.ok ? '✓ ' : '✗ '}${r.message}` : '';
}

function updateSaveLabel() {
  const any = Object.values(fields).some((f) => f.input.value.trim());
  $('save').textContent = any ? 'Save & finish' : 'Continue without keys';
}

async function onSave(e) {
  e.preventDefault();
  const btn = $('save');
  btn.disabled = true;
  try {
    const results = {};
    for (const name of Object.keys(fields)) results[name] = await validate(name);
    const bad = Object.keys(fields).find((n) => fields[n].input.value.trim() && !results[n]?.ok);
    if (bad) {
      fields[bad].input.focus();
      return;
    }
    const gemini = fields.gemini.input.value.trim();
    const psi = fields.psi.input.value.trim();
    await saveSettings({
      geminiApiKey: gemini,
      psiApiKey: psi,
      ...(psi ? { psiEnabled: true } : {}),
      setupDone: true,
      setupSkipped: !gemini && !psi,
    });
    finish(gemini, psi);
  } finally {
    btn.disabled = false;
  }
}

async function onSkip() {
  await saveSettings({ setupDone: true, setupSkipped: true });
  const s = await getSettings();
  finish(s.geminiApiKey, s.psiApiKey);
}

function finish(gemini, psi) {
  const parts = [];
  if (gemini) parts.push('AI insights by Google Gemini');
  if (psi) parts.push('Google PageSpeed scores');
  $('done-text').textContent = parts.length
    ? `Sitelume is ready, with ${parts.join(' and ')}.`
    : 'Sitelume is ready. You can add your Google keys any time in Settings to unlock AI insights and PageSpeed scores.';
  $('setup').hidden = true;
  $('done').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
