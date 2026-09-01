// GET -> the roster of people with admin access, from admin-users.json in
// GitHub (server-side only — unlike overrides.json, this is never served as
// a public static file, since it holds team members' names/emails).
'use strict';
const { checkSession } = require('./_auth');

const REPO = process.env.GITHUB_REPO || 'steph295/bha-rule-search';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH = 'admin-users.json';

function ghHeaders() {
  return {
    Authorization: 'token ' + process.env.GITHUB_TOKEN,
    'User-Agent': 'bha-rule-search-admin',
    Accept: 'application/vnd.github+json'
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!checkSession(req)) { res.status(401).json({ error: 'not signed in' }); return; }
  if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'GITHUB_TOKEN is not configured on the server' }); return; }

  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH + '?ref=' + BRANCH;
  try {
    const r = await fetch(api, { headers: ghHeaders() });
    if (r.status === 404) { res.status(200).json({ users: {} }); return; }
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'GitHub read failed', detail: t });
      return;
    }
    const j = await r.json();
    const current = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    res.status(200).json({ users: current.users || {} });
  } catch (e) {
    res.status(502).json({ error: 'GitHub read failed', detail: String(e) });
  }
};
