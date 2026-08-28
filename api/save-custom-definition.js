// POST { id, term, html } -> creates/updates an admin-authored glossary term
// that isn't part of BHA's own Definitions chapter, or POST { id, delete:
// true } to remove one. Stored under overrides.json's own customDefinitions
// key (separate from definitionOverrides, which only ever patches the html
// of a term BHA's own book already defines) via the GitHub Contents API.
// Mirrors save-definition.js's read-modify-write pattern.
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

function makeId() {
  return 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!checkSession(req)) { res.status(401).json({ error: 'not signed in' }); return; }
  if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'GITHUB_TOKEN is not configured on the server' }); return; }

  const body = req.body || {};
  const isDelete = body.delete === true;
  let id = typeof body.id === 'string' ? body.id.trim() : '';
  const term = typeof body.term === 'string' ? body.term.trim() : '';
  const html = typeof body.html === 'string' ? body.html : '';

  if (isDelete && !id) { res.status(400).json({ error: 'missing id' }); return; }
  if (!isDelete) {
    if (!term) { res.status(400).json({ error: 'missing term' }); return; }
    if (!html) { res.status(400).json({ error: 'nothing to save — provide html' }); return; }
    if (!id) id = makeId();
  }

  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH;

  let current = { overrides: {}, definitionOverrides: {}, bookOverrides: {}, customDefinitions: {} };
  let sha;
  try {
    const getResp = await fetch(api + '?ref=' + BRANCH, { headers: ghHeaders() });
    if (getResp.status === 200) {
      const j = await getResp.json();
      sha = j.sha;
      current = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
      if (!current.overrides) current.overrides = {};
      if (!current.definitionOverrides) current.definitionOverrides = {};
      if (!current.bookOverrides) current.bookOverrides = {};
      if (!current.customDefinitions) current.customDefinitions = {};
    } else if (getResp.status !== 404) {
      const t = await getResp.text();
      res.status(502).json({ error: 'could not read overrides.json from GitHub', detail: t });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: 'GitHub read failed', detail: String(e) });
    return;
  }

  let commitMessage;
  if (isDelete) {
    delete current.customDefinitions[id];
    commitMessage = 'Admin edit: delete custom definition ' + id;
  } else {
    current.customDefinitions[id] = {
      term: term,
      html: html,
      updatedAt: new Date().toISOString()
    };
    commitMessage = 'Admin edit: custom definition ' + id;
  }
  current.updatedAt = new Date().toISOString();

  const newContent = Buffer.from(JSON.stringify(current, null, 1)).toString('base64');
  try {
    const putResp = await fetch(api, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify({
        message: commitMessage,
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

  res.status(200).json({ ok: true, id: id });
};
