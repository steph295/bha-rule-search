// POST { key, title?, html? } -> commits the edit into overrides.json in the
// GitHub repo via the Contents API, and GitHub Pages redeploys itself from
// that commit. This is the ONLY endpoint that writes anything, and it is the
// only place GITHUB_TOKEN (a repo-write secret) is ever used — it never
// reaches the browser.
//
// Also handles whole-rule creation/removal — the base rulebook (rules.json)
// is a fixed snapshot built from BHA's own source, so overrides.json can't
// just add or drop a list item the way it patches an existing one's text.
// Two more fields, both objects on top of the same file:
//   addedEntries: id -> {letter, num, doc, title, html, path, flag, ...} —
//     an admin-authored rule with no BHA original behind it at all, keyed
//     by a permanent id (not its number) so renumbering it later never
//     needs to move it to a new key.
//   deletedEntries: key -> true — hides an ORIGINAL entry from
//     rules.json's own fixed list. (An added entry that's removed is just
//     deleted outright from addedEntries — nothing to hide.)
// POST { addEntry: {...} } creates one; POST { removeEntry: key } removes
// one (whichever kind it is).
'use strict';
const { checkSession } = require('./_auth');

const REPO = process.env.GITHUB_REPO || 'steph295/bha-rule-search';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH = 'overrides.json';
const VALID_FLAGS = ['new', 'updated', 'none', 'not-new'];

function ghHeaders() {
  return {
    Authorization: 'token ' + process.env.GITHUB_TOKEN,
    'User-Agent': 'bha-rule-search-admin',
    Accept: 'application/vnd.github+json'
  };
}

function newEntryId() {
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!checkSession(req)) { res.status(401).json({ error: 'not signed in' }); return; }
  if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'GITHUB_TOKEN is not configured on the server' }); return; }

  const body = req.body || {};
  const addEntry = body.addEntry && typeof body.addEntry === 'object' ? body.addEntry : null;
  const removeEntry = typeof body.removeEntry === 'string' ? body.removeEntry.trim() : '';
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const doDelete = body.delete === true;
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const html = typeof body.html === 'string' ? body.html : '';
  const flag = VALID_FLAGS.includes(body.flag) ? body.flag : undefined;

  if (!addEntry && !removeEntry && !key) { res.status(400).json({ error: 'missing key' }); return; }
  if (!addEntry && !removeEntry && !doDelete && !title && !html) {
    res.status(400).json({ error: 'nothing to save — provide title and/or html' });
    return;
  }
  if (addEntry && (typeof addEntry.html !== 'string' || !addEntry.html || typeof addEntry.title !== 'string' || !addEntry.title)) {
    res.status(400).json({ error: 'addEntry needs at least a title and html' });
    return;
  }

  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH;

  let current = { overrides: {} };
  let sha;
  try {
    const getResp = await fetch(api + '?ref=' + BRANCH, { headers: ghHeaders() });
    if (getResp.status === 200) {
      const j = await getResp.json();
      sha = j.sha;
      current = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
      if (!current.overrides) current.overrides = {};
    } else if (getResp.status !== 404) {
      const t = await getResp.text();
      res.status(502).json({ error: 'could not read overrides.json from GitHub', detail: t });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: 'GitHub read failed', detail: String(e) });
    return;
  }
  if (!current.addedEntries) current.addedEntries = {};
  if (!current.deletedEntries) current.deletedEntries = {};

  let message;
  let responseExtra = {};

  if (addEntry) {
    const id = newEntryId();
    current.addedEntries[id] = {
      letter: typeof addEntry.letter === 'string' ? addEntry.letter : null,
      num: typeof addEntry.num === 'number' ? addEntry.num : null,
      doc: typeof addEntry.doc === 'string' ? addEntry.doc : '',
      title: addEntry.title,
      html: addEntry.html,
      path: Array.isArray(addEntry.path) ? addEntry.path : [],
      flag: VALID_FLAGS.includes(addEntry.flag) ? addEntry.flag : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    message = 'Admin: add rule ' + id;
    responseExtra = { id: id };
  } else if (removeEntry) {
    if (current.addedEntries[removeEntry]) {
      delete current.addedEntries[removeEntry];
    } else {
      current.deletedEntries[removeEntry] = true;
    }
    delete current.overrides[removeEntry];
    message = 'Admin: remove rule ' + removeEntry;
  } else if (doDelete) {
    delete current.overrides[key];
    message = 'Admin revert: ' + key;
  } else if (current.addedEntries[key]) {
    // Editing a previously-added rule's own record directly (not via the
    // overrides patch layer, since it has no BHA original to patch against).
    const prev = current.addedEntries[key];
    current.addedEntries[key] = Object.assign({}, prev, {
      title: title || prev.title,
      html: html || prev.html,
      flag: flag !== undefined ? flag : prev.flag,
      updatedAt: new Date().toISOString()
    });
    message = 'Admin: edit rule ' + key;
  } else {
    const prev = current.overrides[key] || {};
    current.overrides[key] = {
      title: title || prev.title,
      html: html || prev.html,
      flag: flag,
      updatedAt: new Date().toISOString()
    };
    message = 'Admin edit: ' + key;
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

  res.status(200).json(Object.assign({ ok: true, key: key || removeEntry }, responseExtra));
};
