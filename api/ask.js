// POST { messages: [{role, content}, ...] } -> a cited answer from the same
// rules/guides/definitions (plus admin overrides) the rest of the site reads.
//
// Public and unauthenticated by design (it powers /ask), so it is defensive
// about cost: same-origin only, short bounded input, a per-IP rate limit, and
// no model call at all when nothing in the rules matches the question.
// Needs ANTHROPIC_API_KEY set in the Vercel project's environment.
'use strict';
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const {
  buildIndex, searchBoth, expandVocabulary, correctQuery, expand, resolveCited, buildMessages, parseResponse,
  rewriteInput, fallbackQuery, SYSTEM_PROMPT, REWRITE_SYSTEM
} = require('./_ask-lib');

const MODEL = process.env.ASK_MODEL || 'claude-opus-5-5';
// The follow-up rewrite is a tiny task; ASK_REWRITE_MODEL can point it at a
// faster, cheaper model than the one that writes the answer.
const REWRITE_MODEL = process.env.ASK_REWRITE_MODEL || MODEL;
const MAX_QUESTION = 600;
const MAX_HISTORY = 8;
const TOP_K = 10;
const INDEX_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 20 };

const DATA_FILES = { rules: 'rules.json', guides: 'guides.json', definitions: 'definitions.json', overrides: 'overrides.json' };

let cached = null; // { at, index }
const hits = new Map(); // ip -> [timestamps]; per warm instance only

// Overridable so a test can run the handler without the network or an API key.
const deps = {
  client: null,
  getClient() {
    if (!deps.client) deps.client = new Anthropic();
    return deps.client;
  },
  async loadData(host) {
    const out = {};
    for (const [k, file] of Object.entries(DATA_FILES)) {
      try {
        out[k] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
      } catch (e) {
        // not bundled with the function — fall back to the deployment's own static copy
        const r = await fetch('https://' + host + '/' + file);
        if (!r.ok) {
          if (k === 'overrides') { out[k] = {}; continue; }
          throw new Error('could not load ' + file);
        }
        out[k] = await r.json();
      }
    }
    return out;
  }
};

async function getIndex(host) {
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;
  const index = buildIndex(await deps.loadData(host));
  cached = { at: Date.now(), index };
  return index;
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) { // keep the map from growing without bound on a long-lived instance
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_LIMIT.windowMs)) hits.delete(k);
  }
  return recent.length > RATE_LIMIT.max;
}

// Only identifying keys — the server looks the passages up itself, so nothing
// the client sends is ever treated as rule text.
function cleanCited(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).filter((c) => c && typeof c === 'object').map((c) => ({
    kind: String(c.kind || '').slice(0, 20), ref: String(c.ref || '').slice(0, 40),
    title: String(c.title || '').slice(0, 300), doc: String(c.doc || '').slice(0, 300)
  }));
}

function cleanHistory(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const msgs = [];
  for (const m of raw.slice(-MAX_HISTORY)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    const content = m.content.trim().slice(0, m.role === 'user' ? MAX_QUESTION : 2000);
    if (content) msgs.push(m.role === 'assistant' ? { role: m.role, content, cited: cleanCited(m.cited) } : { role: m.role, content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;
  return msgs;
}

// Refusal fallbacks (the model can decline some topics) are opt-in via a beta;
// if the platform rejects the request shape, retry the plain call rather than
// fail the question.
async function callClaude(client, params) {
  try {
    return await client.beta.messages.create(Object.assign({}, params, {
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    }));
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    return client.messages.create(params);
  }
}

// A follow-up like "and what's the penalty?" names nothing to search for, so
// it is rewritten into a standalone question using the conversation so far.
// If that call fails the search falls back to a mechanical version (last
// questions + labels of what was cited) rather than failing the question.
async function standaloneQuery(history, cited) {
  if (history.length < 2) return history[0].content;
  try {
    const r = await deps.getClient().messages.create({
      model: REWRITE_MODEL,
      max_tokens: 1000,
      system: REWRITE_SYSTEM,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: rewriteInput(history, cited) }]
    });
    const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
      .replace(/\s+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').trim().slice(0, 400);
    if (text) return text;
  } catch (err) {
    console.error('rewrite failed:', err && err.status, err && err.message);
  }
  return fallbackQuery(history, cited);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const host = req.headers.host || '';
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === host; } catch (e) { /* malformed origin */ }
    if (!ok) { res.status(403).json({ error: 'forbidden' }); return; }
  }

  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || 'unknown').trim();
  if (rateLimited(ip)) {
    res.status(429).json({ error: 'You’ve asked a lot of questions in a short time — please wait a few minutes and try again.' });
    return;
  }

  const body = req.body || {};
  const history = cleanHistory(body.messages);
  if (!history) { res.status(400).json({ error: 'Ask a question to get started.' }); return; }
  if (!process.env.ANTHROPIC_API_KEY && !deps.client) {
    res.status(503).json({ error: 'The assistant isn’t switched on yet.' });
    return;
  }

  try {
    const index = await getIndex(host);
    const last = history[history.length - 1].content;
    // what the last two answers cited stays in scope for a follow-up
    const cited = [];
    history.filter((m) => m.role === 'assistant').slice(-2).reverse().forEach((m) => (m.cited || []).forEach((c) => cited.push(c)));
    const query = await standaloneQuery(history, cited);
    const carried = resolveCited(index, cited, 6);
    // the standalone query plus the user's own words: the rewrite resolves what
    // "it" means, the original keeps any detail the rewrite dropped
    // typos only affect the search; the model still sees the question as typed
    const fixed = correctQuery(index, query + ' ' + last);
    // everyday wording ("fallen off") also searched as the rulebook's ("unseated")
    const vocab = expandVocabulary(fixed.text);
    const found = expand(index, fixed.text + ' ' + vocab.extra, searchBoth(index, fixed.text, vocab.extra, TOP_K), carried);

    if (!found.length) {
      res.status(200).json({
        answer: 'I couldn’t find anything in the Rules of Racing, Codes or guidance that matches that. Try rewording it, or check the official Rules of Racing.',
        sources: []
      });
      return;
    }

    const response = await callClaude(deps.getClient(), {
      model: MODEL,
      max_tokens: 6000,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'low' },
      messages: buildMessages(history, found)
    });

    if (response.stop_reason === 'refusal') {
      res.status(200).json({ answer: 'I can’t help with that one here. For anything the Rules don’t answer directly, please contact the BHA.', sources: [] });
      return;
    }
    const out = parseResponse(response, found);
    const fixedLast = correctQuery(index, last);
    if (fixedLast.changes.length) out.searchedFor = fixedLast.text;
    res.status(200).json(out);
  } catch (err) {
    console.error('ask failed:', err && err.status, err && err.message);
    if (err instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: 'The assistant is busy right now — please try again in a moment.' });
    } else {
      res.status(502).json({ error: 'Something went wrong getting an answer. Please try again.' });
    }
  }
};

module.exports._deps = deps;
