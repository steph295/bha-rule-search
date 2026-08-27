// POST { termId, html } -> commits an edited glossary definition into
// overrides.json (under its own definitionOverrides key, kept separate from
// the existing rule `overrides` so the two edit flows can't collide) via the
// GitHub Contents API. Mirrors save-rule.js's read-modify-write pattern
// deliberately rather than sharing code with it, so editing a rule and
// editing a definition can never accidentally interfere with each other.
'use strict';
const { checkSession } = require('./_auth');

const REPO = process.env.GITHUB_REPO || 'steph295/bha-rule-search';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH = 'overrides.json';

function ghHeaders() {
  return {
    Authorization: 'token ' + process.env.GITHUB_TOKEN,
    'User-Agent': 'bha-rule-search-admin',
    Accept: 'application/vnd.github+json'
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!checkSession(req)) { res.status(401).json({ error: 'not signed in' }); return; }
  if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'GITHUB_TOKEN is not configured on the server' }); return; }

  const body = req.body || {};
  const termId = typeof body.termId === 'string' || typeof body.termId === 'number' ? String(body.termId).trim() : '';
  const html = typeof body.html === 'string' ? body.html : '';
  if (!termId) { res.status(400).json({ error: 'missing termId' }); return; }
  if (!html) { res.status(400).json({ error: 'nothing to save — provide html' }); return; }

  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH;

  let current = { overrides: {}, definitionOverrides: {} };
  let sha;
  try {
    const getResp = await fetch(api + '?ref=' + BRANCH, { headers: ghHeaders() });
    if (getResp.status === 200) {
      const j = await getResp.json();
      sha = j.sha;
      current = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
      if (!current.overrides) current.overrides = {};
      if (!current.definitionOverrides) current.definitionOverrides = {};
    } else if (getResp.status !== 404) {
      const t = await getResp.text();
      res.status(502).json({ error: 'could not read overrides.json from GitHub', detail: t });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: 'GitHub read failed', detail: String(e) });
    return;
  }

  current.definitionOverrides[termId] = {
    html: html,
    updatedAt: new Date().toISOString()
  };
  current.updatedAt = new Date().toISOString();

  const newContent = Buffer.from(JSON.stringify(current, null, 1)).toString('base64');
  try {
    const putResp = await fetch(api, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify({
        message: 'Admin edit: definition ' + termId,
        content: newContent,
        branch: BRANCH,
        sha: sha
      })
    });
    if (!putResp.ok) {
      const t = await putResp.text();
      res.status(502).json({ error: 'GitHub write failed', detail: t });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: 'GitHub write failed', detail: String(e) });
    return;
  }

  res.status(200).json({ ok: true, termId: termId });
};
