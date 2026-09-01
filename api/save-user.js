// POST { email, name } -> adds/updates an entry in the admin-users roster
// (admin-users.json in GitHub), or POST { email, delete: true } -> removes
// one. This is a roster only — everyone still signs in with the one shared
// admin password (see api/login.js); it doesn't itself grant or revoke the
// ability to log in. Mirrors save-book-meta.js's read-modify-write pattern,
// just against its own file rather than overrides.json, since this file
// holds team members' names/emails and must never be served as a public
// static asset the way overrides.json is.
'use strict';
const { checkSession } = require('./_auth');

const REPO = process.env.GITHUB_REPO || 'steph295/bha-rule-search';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH = 'admin-users.json';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'invalid email' }); return; }

  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH;

  let current = { users: {} };
  let sha;
  try {
    const getResp = await fetch(api + '?ref=' + BRANCH, { headers: ghHeaders() });
    if (getResp.status === 200) {
      const j = await getResp.json();
      sha = j.sha;
      current = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
      if (!current.users) current.users = {};
    } else if (getResp.status !== 404) {
      const t = await getResp.text();
      res.status(502).json({ error: 'could not read admin-users.json from GitHub', detail: t });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: 'GitHub read failed', detail: String(e) });
    return;
  }

  let message;
  if (body.delete === true) {
    if (!current.users[email]) { res.status(200).json({ ok: true }); return; }
    delete current.users[email];
    message = 'Admin: remove user ' + email;
  } else {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    current.users[email] = { name: name, grantedAt: new Date().toISOString() };
    message = 'Admin: add user ' + email;
  }
  current.updatedAt = new Date().toISOString();

  const newContent = Buffer.from(JSON.stringify(current, null, 1)).toString('base64');
  try {
    const putResp = await fetch(api, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify({ message: message, content: newContent, branch: BRANCH, sha: sha })
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

  res.status(200).json({ ok: true, users: current.users });
};
