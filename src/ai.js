/**
 * AI insights: an AI-written executive summary and site-specific
 * recommendations for the highest-priority issues. Two engines:
 *
 *  - 'chrome'  Chrome's built-in model (Gemini Nano, Prompt API). Free, no key,
 *              audit data never leaves the computer; needs capable hardware.
 *  - 'gemini'  Google Gemini API with the user's own key (free tier works).
 *              One request per report, to stay well inside free daily caps.
 *
 * Both run in extension pages (not the service worker). Detection stays
 * rule-based: the model only rewrites explanations, and every output is checked
 * against the audit data before use — text that mentions a number not present
 * in the input is discarded.
 */

const LANG = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const MAX_ISSUES = { chrome: 6, gemini: 10 }; // on-device prompts are sequential, so keep that list short
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_TIMEOUT_MS = 120000;

export const GEMINI_MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (best writing)' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (faster, higher free limits)' },
];

const SYSTEM = `You are a senior web consultant writing part of a website audit report that an agency will send to a business owner.
The report already shows each finding and a standard explanation, so never restate them. Your job is to add what a generic checklist cannot:
what this specific business sells and to whom, how each problem affects its customers, and what to do on this exact site.
Rules:
- Use only the facts in the audit data and page content you are given. Never invent numbers, statistics, findings, tools, plugins, reviews or menu names.
- Only mention a platform, plugin or tool if it appears in the detected technology list.
- Refer to real things on the page (its headings, buttons, services, affected elements) when it helps.
- Write plain, confident English for a non-technical reader. No markdown, no bullet symbols, no emojis.`;

const SUMMARY_TASK = `Write the executive summary as 2 or 3 short paragraphs (each under 70 words):
1. What this business offers and to whom (from the page content), and how healthy the website is overall.
2. The two or three problems that matter most for this business's customers, and what they cost in enquiries, sales or trust.
3. The recommended first step, including the estimated hours and projected score if given.`;

const ISSUE_TASK = `- "recommendation": 2 or 3 sentences on what this problem means for this business's customers specifically. Do not repeat the finding or the standard explanation; add the business consequence.
- "steps": 3 to 5 concrete steps for this exact site. Name the affected elements or pages where listed, and use the detected platform's terms where it clearly applies. Do not copy the standard steps word for word.`;

const QUICK_WINS_TASK = `"quickWins": the 3 changes that would most improve results for the least effort, chosen from the issues above. For each give the exact issue "id" and a one-sentence "action" written for this site.`;

const CONTENT_TASK = `"contentReview": judge the page content itself (not the technical issues), using the page excerpt, navigation, buttons and contact signals:
- "verdict": one sentence on how well the page persuades a visitor to get in touch or buy.
- "findings": 3 to 5 items, each with "area" (one of: Value proposition, Calls to action, Trust signals, Contact options, Readability, Local relevance), "observation" (what this page actually does, citing its real wording where useful) and "suggestion" (a specific improvement).`;

// Chrome's Prompt API takes standard JSON Schema; kept minimal (the prompt states the counts).
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { paragraphs: { type: 'array', items: { type: 'string' } } },
  required: ['paragraphs'],
};
const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    recommendation: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['recommendation', 'steps'],
};
// Gemini's responseSchema uses its OpenAPI-style subset.
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'ARRAY', items: { type: 'STRING' } },
    quickWins: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'STRING' }, action: { type: 'STRING' } },
        required: ['id', 'action'],
      },
    },
    contentReview: {
      type: 'OBJECT',
      properties: {
        verdict: { type: 'STRING' },
        findings: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { area: { type: 'STRING' }, observation: { type: 'STRING' }, suggestion: { type: 'STRING' } },
            required: ['area', 'observation', 'suggestion'],
          },
        },
      },
      required: ['verdict', 'findings'],
    },
    issues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          recommendation: { type: 'STRING' },
          steps: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['id', 'recommendation', 'steps'],
      },
    },
  },
  required: ['summary', 'quickWins', 'contentReview', 'issues'],
};

/** Which engine a report should use, given the user's settings. */
export function resolveProvider(settings) {
  if (settings.aiProvider === 'chrome') return 'chrome';
  if (settings.aiProvider === 'gemini') return 'gemini';
  return settings.geminiApiKey ? 'gemini' : 'chrome'; // 'auto'
}

/**
 * Chrome built-in model availability.
 * @returns {Promise<'unsupported'|'unavailable'|'downloadable'|'downloading'|'available'>}
 */
export async function aiStatus() {
  if (!('LanguageModel' in self)) return 'unsupported';
  try {
    return await LanguageModel.availability(LANG);
  } catch {
    return 'unavailable';
  }
}

/**
 * @param {object} audit  stored audit record
 * @param {{ provider?: 'chrome'|'gemini', apiKey?: string, model?: string,
 *           onProgress?: (p: {phase: string, loaded?: number, done?: number, total?: number, model?: string}) => void,
 *           signal?: AbortSignal }} opts
 */
export async function generateInsights(audit, opts = {}) {
  return opts.provider === 'gemini' ? viaGemini(audit, opts) : viaChrome(audit, opts);
}

function targetsFor(audit, provider) {
  return audit.result.issues.filter((i) => i.priority <= 2).slice(0, MAX_ISSUES[provider]);
}

/** Applies the grounding check to raw model output and fills in the stored result. */
function accept(out, { paragraphs, summaryInput, issues, quickWins, contentReview, fullInput = '', contentInput = '', issueIds = [] }) {
  const p = (paragraphs || []).map(clean).filter(Boolean).slice(0, 3);
  if (p.length && grounded(p.join(' '), summaryInput)) out.summary = { paragraphs: p };
  else out.rejected++;
  for (const { issue, input, res } of issues) {
    const recommendation = clean(res?.recommendation);
    const steps = (res?.steps || []).map(clean).filter(Boolean).slice(0, 5);
    if (recommendation && steps.length && grounded(`${recommendation} ${steps.join(' ')}`, input)) {
      out.issues[issue.id] = { recommendation, steps };
    } else {
      out.rejected++;
    }
  }

  // Gemini-only sections: each item is kept or dropped on its own.
  if (Array.isArray(quickWins)) {
    out.quickWins = quickWins
      .map((w) => ({ id: String(w?.id || ''), action: clean(w?.action) }))
      .filter((w) => issueIds.includes(w.id) && w.action && grounded(w.action, fullInput))
      .slice(0, 3);
  }
  if (contentReview && typeof contentReview === 'object') {
    const findings = (Array.isArray(contentReview.findings) ? contentReview.findings : [])
      .map((f) => ({ area: clean(f?.area), observation: clean(f?.observation), suggestion: clean(f?.suggestion) }))
      .filter((f) => f.area && f.observation && f.suggestion && grounded(`${f.observation} ${f.suggestion}`, contentInput))
      .slice(0, 5);
    const verdict = clean(contentReview.verdict);
    if (findings.length) out.contentReview = { verdict: verdict && grounded(verdict, contentInput) ? verdict : '', findings };
    else out.rejected++;
  }
  return out;
}

// ───────────── Chrome built-in AI ─────────────

async function viaChrome(audit, { onProgress = () => {}, signal } = {}) {
  const context = siteContext(audit);
  let base;
  try {
    base = await LanguageModel.create({
      ...LANG,
      signal,
      initialPrompts: [{ role: 'system', content: SYSTEM }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress({ phase: 'download', loaded: e.loaded }));
      },
    });
  } catch (e) {
    throw chromeError(e);
  }
  const out = { provider: 'chrome', model: 'Chrome built-in AI (Gemini Nano)', generatedAt: new Date().toISOString(), summary: null, issues: {}, rejected: 0 };
  // A failed prompt only loses that one piece; the run fails only if every prompt does.
  let lastError = null;
  const soft = (e) => {
    if (e?.name === 'AbortError') throw e;
    lastError = e;
    return null;
  };
  try {
    onProgress({ phase: 'summary' });
    const summaryInput = `${context}\n\n${summaryFacts(audit)}`;
    const summary = await ask(base, `${summaryInput}\n\n${SUMMARY_TASK}\nRespond as JSON matching the schema.`, SUMMARY_SCHEMA, signal).catch(soft);

    const targets = targetsFor(audit, 'chrome');
    const issues = [];
    for (let n = 0; n < targets.length; n++) {
      const issue = targets[n];
      onProgress({ phase: 'issues', done: n, total: targets.length });
      const input = `${context}\n\n${issueFacts(issue)}`;
      const res = await ask(
        base,
        `${input}\n\nWrite a recommendation for fixing this issue on this specific website:\n${ISSUE_TASK}\nRespond as JSON matching the schema.`,
        ISSUE_SCHEMA,
        signal
      ).catch(soft);
      issues.push({ issue, input, res });
    }
    onProgress({ phase: 'issues', done: targets.length, total: targets.length });
    if (lastError && !summary && issues.every((x) => !x.res)) throw chromeError(lastError);
    return accept(out, { paragraphs: summary?.paragraphs, summaryInput, issues });
  } finally {
    base.destroy();
  }
}

/** Turns Chrome Prompt API DOMExceptions into messages a user can act on. */
function chromeError(e) {
  if (e?.name === 'AbortError') return e;
  const name = e?.name || 'Error';
  const useGemini = 'Add a free Gemini API key in Settings → AI insights to use Google Gemini instead.';
  const messages = {
    NotAllowedError: 'Chrome needs a fresh click to start its built-in AI. Click Generate again.',
    NotSupportedError: `Chrome’s built-in AI can’t run this request on this computer. ${useGemini}`,
    QuotaExceededError: `This audit is too large for Chrome’s on-device AI. ${useGemini}`,
    InvalidStateError: 'Chrome’s built-in AI isn’t ready yet. The model may still be downloading, so try again in a few minutes.',
  };
  const err = new Error(`${messages[name] || `Chrome’s built-in AI failed. ${useGemini}`} (${name}${e?.message ? `: ${e.message}` : ''})`);
  err.cause = e;
  return err;
}

/** One question per cloned session, so prompts never compete for the context window. */
async function ask(base, prompt, schema, signal) {
  const s = await base.clone({ signal });
  try {
    const raw = await s.prompt(prompt, { responseConstraint: schema, signal });
    return JSON.parse(raw);
  } finally {
    s.destroy();
  }
}

// ───────────── Google Gemini API ─────────────

async function viaGemini(audit, { apiKey, model = GEMINI_MODELS[0].id, onProgress = () => {}, signal } = {}) {
  if (!apiKey) throw new Error('Add a Gemini API key in Settings → AI insights.');
  const context = [siteContext(audit), pageContent(audit)].filter(Boolean).join('\n\n');
  const facts = summaryFacts(audit);
  const issueBlocks = targetsFor(audit, 'gemini').map((issue) => ({ issue, facts: issueFacts(issue) }));

  const prompt = [
    context,
    facts,
    ...issueBlocks.map(({ issue, facts: f }) => `[ISSUE id=${issue.id}]\n${f}`),
    `TASKS
1. "summary": ${SUMMARY_TASK}
2. ${QUICK_WINS_TASK}
3. ${CONTENT_TASK}
4. "issues": for EACH issue above, return an object with its exact "id" and:
${ISSUE_TASK}
Respond as JSON matching the schema.`,
  ].join('\n\n');

  // Try the chosen model first, then the others. Busy responses (500/503) are
  // retried once after a pause; busy-again or quota (429) moves to the next
  // model, since each model has its own free-tier quota.
  const request = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, temperature: 0.4 },
  };
  const chain = [model, ...GEMINI_MODELS.map((m) => m.id).filter((id) => id !== model)];
  let res;
  let body;
  let used = model;
  let lastError = null;
  attempts: for (const candidate of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      used = candidate;
      onProgress({ phase: 'remote', model: candidate, retry: candidate !== model || attempt > 0 });
      ({ res, body } = await callGemini(candidate, apiKey, request, signal));
      if (res.ok && !body.error) break attempts;
      lastError = geminiError(res.status, body.error?.message || '', candidate);
      if (res.status === 500 || res.status === 503) {
        if (attempt === 0) await sleep(3000, signal);
        continue;
      }
      if (res.status === 429 || res.status === 404) continue attempts; // try the next model
      throw new Error(lastError);
    }
  }
  if (!res.ok || body.error) throw new Error(lastError);
  if (body.promptFeedback?.blockReason) throw new Error(`Gemini declined the request (${body.promptFeedback.blockReason}).`);
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  if (!text) throw new Error(cand?.finishReason ? `Gemini returned no text (${cand.finishReason}).` : 'Gemini returned an empty response.');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(cand?.finishReason === 'MAX_TOKENS' ? 'Gemini’s answer was cut off. Try again.' : 'Gemini’s answer wasn’t valid JSON. Try again.');
  }

  const byId = new Map((Array.isArray(data.issues) ? data.issues : []).map((x) => [String(x?.id), x]));
  const out = { provider: 'gemini', model: `Google Gemini (${used})`, generatedAt: new Date().toISOString(), summary: null, issues: {}, rejected: 0 };
  return accept(out, {
    paragraphs: Array.isArray(data.summary) ? data.summary : [],
    summaryInput: `${context}\n\n${facts}`,
    // Each recommendation is grounded only against its own issue's facts.
    issues: issueBlocks.map(({ issue, facts: f }) => ({ issue, input: `${context}\n\n${f}`, res: byId.get(issue.id) })),
    quickWins: data.quickWins,
    contentReview: data.contentReview,
    fullInput: prompt,
    contentInput: context,
    issueIds: issueBlocks.map(({ issue }) => issue.id),
  });
}

/** One generateContent call with a timeout; network failures become friendly errors. */
async function callGemini(model, apiKey, request, signal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, GEMINI_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey.trim() },
      body: JSON.stringify(request),
    });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  } catch {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (timedOut) throw new Error('Gemini took too long to respond. Try again.');
    throw new Error('Could not reach Google Gemini. Check your internet connection.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Cancelled', 'AbortError'));
    });
  });
}

function geminiError(status, message, model) {
  if (status === 500 || status === 503) {
    return 'Google Gemini is busy right now (high demand on the free tier). Wait a minute and try again.';
  }
  if (status === 429) {
    return 'Gemini’s free limit has been reached (per minute or per day). Wait a while, or switch to Flash-Lite in Settings → AI insights.';
  }
  if (/API key not valid|API_KEY_INVALID/i.test(message)) return 'The Gemini API key in Settings is not valid.';
  if (status === 403) return 'This API key isn’t allowed to use the Gemini API. Create a key in Google AI Studio, or enable the Generative Language API for its project.';
  if (status === 404) return `The model “${model}” isn’t available for your key. Choose another model in Settings → AI insights.`;
  return `Gemini error${status ? ` (${status})` : ''}: ${message.slice(0, 200) || 'unknown error'}`;
}

// ───────────── prompt inputs (kept compact for the small on-device context window) ─────────────

function siteContext(audit) {
  const raw = audit.raw;
  const r = audit.result;
  const headings = raw.seo.headings
    .filter((h) => h.level <= 2)
    .slice(0, 8)
    .map((h) => h.text)
    .filter(Boolean);
  const tech = r.tech.map((t) => (t.version ? `${t.name} ${t.version}` : t.name)).slice(0, 25);
  return [
    `WEBSITE: ${audit.host}`,
    `Page title: ${clip(raw.seo.title || audit.title, 120)}`,
    raw.seo.description ? `Meta description: ${clip(raw.seo.description, 200)}` : '',
    headings.length ? `Main headings: ${headings.map((h) => clip(h, 60)).join(' | ')}` : '',
    `Detected technology: ${tech.length ? tech.join(', ') : 'none detected'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The page's own copy and conversion signals. Gemini only: too large for the on-device context window. */
function pageContent(audit) {
  const c = audit.raw.content;
  if (!c) return '';
  const forms = (audit.raw.forms || []).filter((f) => f.fields > 0 && f.visible && !f.isSearch).length;
  return [
    'PAGE CONTENT',
    c.navItems?.length ? `Navigation: ${c.navItems.join(' | ')}` : '',
    c.ctas?.length ? `Buttons and calls to action: ${c.ctas.map((x) => `"${x}"`).join(', ')}` : 'Buttons and calls to action: none found',
    `Contact options: ${c.phoneLinks} clickable phone link(s), ${c.emailLinks} email link(s), ${forms} enquiry form(s)` +
      (c.socialProfiles?.length ? `, social profiles: ${c.socialProfiles.join(', ')}` : ', no social profile links'),
    c.textSample ? `Page text excerpt:\n"""\n${c.textSample}\n"""` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function summaryFacts(audit) {
  const r = audit.result;
  const psi = audit.psi && !audit.psi.error ? audit.psi : null;
  const cats = Object.entries(r.scores).map(([k, v]) => `${k} ${v}/100`).join(', ');
  const top = r.issues.slice(0, 8).map((i) => `- [${i.severity}] ${i.title}${i.detail ? ` — ${clip(i.detail, 140)}` : ''}`);
  const p1 = r.phases[0];
  return [
    'AUDIT RESULTS',
    `Overall score: ${r.overall}/100 (${r.grade.label})`,
    `Category scores: ${cats}`,
    `Issues: ${r.issues.length} total — ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`,
    psi?.score != null ? `Google PageSpeed (${psi.strategy}): ${psi.score}/100` : '',
    psi?.field ? `Real-visitor Core Web Vitals: ${psi.field.cwvPassed ? 'passed' : 'failed'}` : '',
    'Most important issues:',
    ...top,
    p1?.issueCount ? `Recommended first phase: ${p1.issueCount} fixes, about ${p1.hours} hours, projected overall score ${p1.projectedOverall}/100` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function issueFacts(i) {
  return [
    'ISSUE',
    `Title: ${i.title}`,
    `Severity: ${i.severity}`,
    i.detail ? `Finding: ${clip(i.detail, 200)}` : '',
    i.items?.length ? `Affected on this page:\n${i.items.slice(0, 5).map((x) => `- ${clip(x, 140)}`).join('\n')}` : '',
    `Why it matters: ${i.why}`,
    `Standard fix steps:\n${i.fix.map((f, n) => `${n + 1}. ${f}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ───────────── output checks ─────────────

/** Rejects text that states any number (other than small counting numbers) not present in the input. */
export function grounded(text, input) {
  const norm = (s) => s.replace(/,(?=\d{3}\b)/g, '');
  const allowed = new Set((norm(input).match(/\d+(?:\.\d+)?/g) || []).map(Number));
  for (const n of (norm(text).match(/\d+(?:\.\d+)?/g) || []).map(Number)) {
    if (n <= 10 || allowed.has(n)) continue;
    return false;
  }
  return true;
}

/** Strips markdown emphasis and list/heading markers, but leaves code such as <html lang="en"> intact. */
function clean(s) {
  return String(s || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(?:[#>]+|[-•*]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
