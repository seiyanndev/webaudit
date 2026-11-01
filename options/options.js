import { getSettings, saveSettings, listAudits, deleteAudit, clearAudits, DEFAULT_INTRO, DEFAULT_CTA } from '../src/storage.js';
import { esc, toneFor, fmtDateTime, applyBrand } from '../shared/ui.js';
import { checkGeminiKey, checkPsiKey } from '../src/keys.js';

const form = document.getElementById('form');
const NUMERIC = ['hourlyRate', 'hoursPerWeek', 'maxLinks'];
let logo = null;
let photo = null;

init();

async function init() {
  const s = await getSettings();
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  logo = s.logo;
  photo = s.consultantPhoto;
  applyColor(s.brandColor);
  renderLogo();
  renderPhoto();
  form.elements.introNote.placeholder = DEFAULT_INTRO;
  form.elements.ctaHeading.placeholder = DEFAULT_CTA.heading;
  form.elements.ctaButton.placeholder = DEFAULT_CTA.button;
  form.elements.ctaMessage.placeholder = DEFAULT_CTA.message;
  renderHistory();

  form.elements.brandColor.addEventListener('input', (e) => applyColor(e.target.value));
  document.getElementById('logo-file').addEventListener('change', onLogo);
  document.getElementById('logo-clear').addEventListener('click', () => {
    logo = null;
    document.getElementById('logo-file').value = '';
    renderLogo();
  });
  document.getElementById('photo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    photo = await downscale(file, 320);
    renderPhoto();
  });
  document.getElementById('photo-clear').addEventListener('click', () => {
    photo = null;
    document.getElementById('photo-file').value = '';
    renderPhoto();
  });
  form.addEventListener('submit', onSave);
  for (const [name, check] of [['geminiApiKey', checkGeminiKey], ['psiApiKey', checkPsiKey]]) {
    const input = form.elements[name];
    if (input.value) checkKey(name, check);
    input.addEventListener('change', () => checkKey(name, check));
  }
  document.getElementById('clear').addEventListener('click', async () => {
    if (!confirm('Delete all saved audits? This cannot be undone.')) return;
    await clearAudits();
    renderHistory();
  });
}

/** Shows a ✓/✗ line under a key field; quota-free check against Google. */
async function checkKey(name, check) {
  const el = document.querySelector(`.key-status[data-for="${name}"]`);
  const value = form.elements[name].value.trim();
  if (!value) {
    el.className = 'key-status';
    el.textContent = '';
    return;
  }
  el.className = 'key-status busy';
  el.textContent = 'Checking…';
  const r = await check(value);
  if (form.elements[name].value.trim() !== value) return; // changed while checking
  el.className = `key-status ${r.ok ? 'ok' : 'bad'}`;
  el.textContent = `${r.ok ? '✓' : '✗'} ${r.message}`;
}

function applyColor(c) {
  applyBrand(c);
  document.getElementById('color-value').textContent = c;
}

function renderPhoto() {
  document.getElementById('photo-preview').innerHTML = photo ? `<img src="${esc(photo)}" alt="Consultant photo preview" />` : 'No photo';
}

function renderLogo() {
  document.getElementById('logo-preview').innerHTML = logo ? `<img src="${esc(logo)}" alt="Logo preview" />` : 'No logo';
}

async function onLogo(e) {
  const file = e.target.files[0];
  if (!file) return;
  logo = file.type === 'image/svg+xml' ? await readAsDataUrl(file) : await downscale(file, 600);
  renderLogo();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** Keeps stored logos small: longest side capped, PNG to preserve transparency. */
async function downscale(file, max) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

async function onSave(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  for (const k of NUMERIC) data[k] = Math.max(0, Number(data[k]) || 0);
  data.hoursPerWeek = data.hoursPerWeek || 20;
  // FormData omits unchecked boxes, so read every checkbox explicitly.
  for (const el of form.querySelectorAll('input[type="checkbox"][name]')) data[el.name] = el.checked;
  data.geminiApiKey = data.geminiApiKey.trim();
  data.psiApiKey = data.psiApiKey.trim();
  data.logo = logo;
  data.consultantPhoto = photo;
  await saveSettings(data);
  const saved = document.getElementById('saved');
  saved.textContent = 'Saved';
  setTimeout(() => (saved.textContent = ''), 2000);
}

async function renderHistory() {
  const audits = await listAudits();
  document.getElementById('history-empty').hidden = audits.length > 0;
  document.querySelector('.history').hidden = audits.length === 0;
  const body = document.getElementById('history');
  body.innerHTML = audits
    .map(
      (a) => `
    <tr>
      <td><strong class="tone-${toneFor(a.overall)}">${a.overall}</strong></td>
      <td><a href="../report/report.html?id=${esc(a.id)}" target="_blank">${esc(a.url.replace(/^https?:\/\/(www\.)?/, ''))}</a></td>
      <td class="muted">${esc(fmtDateTime(a.createdAt))}</td>
      <td><button class="link-btn" data-id="${esc(a.id)}" type="button">Delete</button></td>
    </tr>`
    )
    .join('');
  for (const b of body.querySelectorAll('.link-btn')) {
    b.addEventListener('click', async () => {
      await deleteAudit(b.dataset.id);
      renderHistory();
    });
  }
}
