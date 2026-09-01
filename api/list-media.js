// GET ?path=uploads[/sub/...] -> lists files/folders at that path in the repo
// via the GitHub Contents API. The Media Library is scoped to uploads/ (the
// same directory upload-guide.js already writes into) so this never exposes
// the rest of the repo (source code, admin.js, etc.) to a browsable listing.
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

// Git has no real empty directories — "folders" only exist here because
// create-media-folder.js drops a .gitkeep placeholder inside them, which
// is filtered out of every listing below.
function normalizeMediaPath(raw) {
  let p = String(raw || MEDIA_ROOT).trim().replace(/^\/+|\/+$/g, '');
  if (!p) p = MEDIA_ROOT;
  if (p !== MEDIA_ROOT && p.indexOf(MEDIA_ROOT + '/') !== 0) return null;
  if (p.split('/').indexOf('..') !== -1) return null;
  return p;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!checkSession(req)) { res.status(401).json({ error: 'not signed in' }); return; }
  if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'GITHUB_TOKEN is not configured on the server' }); return; }

  const path = normalizeMediaPath(req.query && req.query.path);
  if (path === null) { res.status(400).json({ error: 'invalid path' }); return; }

  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + path + '?ref=' + BRANCH;
  try {
    const r = await fetch(api, { headers: ghHeaders() });
    if (r.status === 404) { res.status(200).json({ path: path, items: [] }); return; }
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'GitHub read failed', detail: t });
      return;
    }
    const j = await r.json();
    const list = Array.isArray(j) ? j : [j];
    const items = list
      .filter(function (it) { return it.name !== '.gitkeep'; })
      .map(function (it) {
        return {
          name: it.name,
          path: it.path,
          type: it.type === 'dir' ? 'dir' : 'file',
          size: it.size || 0,
          url: it.download_url || null
        };
      })
      .sort(function (a, b) {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.status(200).json({ path: path, items: items });
  } catch (e) {
    res.status(502).json({ error: 'GitHub read failed', detail: String(e) });
  }
};
