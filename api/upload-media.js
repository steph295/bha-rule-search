// POST { path, filename, fileBase64 } -> writes a file straight into the
// repo's uploads/ tree via the GitHub Contents API. Separate from
// upload-guide.js: that endpoint also extracts PDF text into a Guide
// Library entry, which only makes sense for guide PDFs — this one is a
// plain file store for the Media Library (images or PDFs).
'use strict';
const { checkSession } = require('./_auth');

const REPO = process.env.GITHUB_REPO || 'steph295/bha-rule-search';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const MEDIA_ROOT = 'uploads';
const MAX_BYTES = 3 * 1024 * 1024; // matches upload-guide.js's cap
const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];

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

function safeFilename(name) {
  const base = String(name || 'file').split('/').pop().split('\\').pop();
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return cleaned || 'file';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!checkSession(req)) { res.status(401).json({ error: 'not signed in' }); return; }
  if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'GITHUB_TOKEN is not configured on the server' }); return; }

  const body = req.body || {};
  const folder = normalizeMediaPath(body.path);
  if (folder === null) { res.status(400).json({ error: 'invalid path' }); return; }

  const filename = safeFilename(body.filename);
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ALLOWED_EXT.indexOf(ext) === -1) {
    res.status(400).json({ error: 'unsupported file type — allowed: ' + ALLOWED_EXT.join(', ') });
    return;
  }

  const fileBase64 = typeof body.fileBase64 === 'string' ? body.fileBase64 : '';
  if (!fileBase64) { res.status(400).json({ error: 'missing file' }); return; }

  let buf;
  try {
    buf = Buffer.from(fileBase64, 'base64');
  } catch (e) {
    res.status(400).json({ error: 'invalid file data' }); return;
  }
  if (buf.length > MAX_BYTES) {
    res.status(400).json({ error: 'file is too large — this tool supports files up to 3MB' });
    return;
  }

  const filePath = folder + '/' + filename;
  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + filePath;
  try {
    // Overwriting an existing file needs its current sha — best-effort look-up.
    let sha;
    const getResp = await fetch(api + '?ref=' + BRANCH, { headers: ghHeaders() });
    if (getResp.status === 200) {
      const j = await getResp.json();
      sha = j.sha;
    }

    const putResp = await fetch(api, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify({ message: 'Admin media upload: ' + filePath, content: fileBase64, branch: BRANCH, sha: sha })
    });
    if (!putResp.ok) {
      const t = await putResp.text();
      res.status(502).json({ error: 'GitHub write failed', detail: t });
      return;
    }
    const putJson = await putResp.json();
    res.status(200).json({ ok: true, path: filePath, url: putJson.content && putJson.content.download_url });
  } catch (e) {
    res.status(502).json({ error: 'GitHub write failed', detail: String(e) });
  }
};
