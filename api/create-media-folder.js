// POST { path, name } -> creates a "folder" under uploads/ by committing a
// .gitkeep placeholder inside it — git has no concept of an empty directory,
// so this is the standard trick to make one show up in a listing at all.
'use strict';
const { checkSession } = require('./_auth');

const REPO = process.env.GITHUB_REPO || 'steph295/bha-rule-search';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const MEDIA_ROOT = 'uploads';

function ghHeaders() {
  return {
    Authorization: 'token ' + process.env.GITHUB_TOKEN,
    'User-Agent': 'bha-rule-search-admin',
    Accept: 'application/vnd.github+json'
  };
}

function normalizeMediaPath(raw) {
  let p = String(raw || MEDIA_ROOT).trim().replace(/^\/+|\/+$/g, '');
  if (!p) p = MEDIA_ROOT;
  if (p !== MEDIA_ROOT && p.indexOf(MEDIA_ROOT + '/') !== 0) return null;
  if (p.split('/').indexOf('..') !== -1) return null;
  return p;
}

function safeFolderName(name) {
  return String(name || '').trim().replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!checkSession(req)) { res.status(401).json({ error: 'not signed in' }); return; }
  if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'GITHUB_TOKEN is not configured on the server' }); return; }

  const body = req.body || {};
  const parent = normalizeMediaPath(body.path);
  if (parent === null) { res.status(400).json({ error: 'invalid path' }); return; }

  const name = safeFolderName(body.name);
  if (!name) { res.status(400).json({ error: 'give the folder a name' }); return; }

  const folderPath = parent + '/' + name;
  const placeholderApi = 'https://api.github.com/repos/' + REPO + '/contents/' + folderPath + '/.gitkeep';
  try {
    const putResp = await fetch(placeholderApi, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify({ message: 'Admin: create media folder ' + folderPath, content: '', branch: BRANCH })
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

  res.status(200).json({ ok: true, path: folderPath });
};
