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
const { buildIndex, search, buildMessages, parseResponse, SYSTEM_PROMPT } = require('./_ask-lib');

const MODEL = process.env.ASK_MODEL || 'claude-opus-5-5';
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

function cleanHistory(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const msgs = [];
  for (const m of raw.slice(-MAX_HISTORY)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    const content = m.content.trim().slice(0, m.role === 'user' ? MAX_QUESTION : 2000);
    if (content) msgs.push({ role: m.role, content });
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
    // A short follow-up ("and for a jockey?") searches on the question before it too.
    const last = history[history.length - 1].content;
    const prevUser = history.filter((m) => m.role === 'user').slice(-2, -1)[0];
    const query = last.length < 40 && prevUser ? prevUser.content + ' ' + last : last;
    const found = search(index, query, TOP_K);

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
    res.status(200).json(parseResponse(response, found));
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
