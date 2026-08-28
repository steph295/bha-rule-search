// POST { filename, title, cat, fileBase64 } -> stores the uploaded PDF in
// the repo (uploads/<id>.pdf) and a lightweight Guide Library entry
// (overrides.json's own uploadedGuides key) via the GitHub Contents API.
// Text is extracted with pdf-parse into plain paragraphs — no rule-numbering
// parser exists in this app, so this deliberately produces one simple entry
// per document, same shape as an existing Guide Library item.
//
// POST { id, delete: true } removes the overrides.json entry (the stored
// PDF blob is left in the repo — harmless, and still recoverable via git
// history if that was a mistake).
'use strict';
const { checkSession } = require('./_auth');
const pdfParse = require('pdf-parse');

const REPO = process.env.GITHUB_REPO || 'steph295/bha-rule-search';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://steph295.github.io/bha-rule-search/';
const FILE_PATH = 'overrides.json';
const MAX_BYTES = 3 * 1024 * 1024; // raw PDF size cap — see note on Vercel's ~4.5MB request body limit

function ghHeaders() {
  return {
    Authorization: 'token ' + process.env.GITHUB_TOKEN,
    'User-Agent': 'bha-rule-search-admin',
    Accept: 'application/vnd.github+json'
  };
}

function makeId() {
  return 'upload-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Mirrors admin.js's plainTextToHtml: blank lines start a new paragraph.
// pdf-parse rarely preserves real paragraph breaks, so most PDFs will come
// out as one or a few large paragraphs — acceptable for a simple, unparsed
// Guide Library attachment rather than a fully rule-structured document.
function textToHtml(text) {
  var paras = String(text || '')
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map(function (p) { return p.replace(/\s+/g, ' ').trim(); })
    .filter(Boolean);
  if (!paras.length) return '<p class="l0">(No extractable text found in this PDF.)</p>';
  return paras.map(function (p) { return '<p class="l0">' + escapeHtml(p) + '</p>'; }).join('');
}

async function githubGetOverrides(api) {
  const getResp = await fetch(api + '?ref=' + BRANCH, { headers: ghHeaders() });
  if (getResp.status === 200) {
    const j = await getResp.json();
    const current = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    if (!current.overrides) current.overrides = {};
    if (!current.definitionOverrides) current.definitionOverrides = {};
    if (!current.bookOverrides) current.bookOverrides = {};
    if (!current.customDefinitions) current.customDefinitions = {};
    if (!current.uploadedGuides) current.uploadedGuides = {};
    return { current: current, sha: j.sha };
  }
  if (getResp.status === 404) {
    return { current: { overrides: {}, definitionOverrides: {}, bookOverrides: {}, customDefinitions: {}, uploadedGuides: {} }, sha: undefined };
  }
  const t = await getResp.text();
  throw Object.assign(new Error('could not read overrides.json from GitHub'), { detail: t });
}

async function githubPutFile(path, base64Content, message, existingSha) {
  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + path;
  const body = { message: message, content: base64Content, branch: BRANCH };
  if (existingSha) body.sha = existingSha;
  const putResp = await fetch(api, {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
    body: JSON.stringify(body)
  });
  if (!putResp.ok) {
    const t = await putResp.text();
    throw Object.assign(new Error('GitHub write failed for ' + path), { detail: t });
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!checkSession(req)) { res.status(401).json({ error: 'not signed in' }); return; }
  if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'GITHUB_TOKEN is not configured on the server' }); return; }

  const body = req.body || {};
  const overridesApi = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH;

  if (body.delete === true) {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) { res.status(400).json({ error: 'missing id' }); return; }
    try {
      const { current, sha } = await githubGetOverrides(overridesApi);
      delete current.uploadedGuides[id];
      current.updatedAt = new Date().toISOString();
      await githubPutFile(FILE_PATH, Buffer.from(JSON.stringify(current, null, 1)).toString('base64'),
        'Admin edit: remove uploaded guide ' + id, sha);
    } catch (e) {
      res.status(502).json({ error: e.message, detail: e.detail }); return;
    }
    res.status(200).json({ ok: true, id: id });
    return;
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const cat = typeof body.cat === 'string' ? body.cat.trim() : '';
  const filename = typeof body.filename === 'string' ? body.filename.trim() : 'document.pdf';
  const fileBase64 = typeof body.fileBase64 === 'string' ? body.fileBase64 : '';
  if (!title) { res.status(400).json({ error: 'missing title' }); return; }
  if (!fileBase64) { res.status(400).json({ error: 'missing file' }); return; }

  let buf;
  try {
    buf = Buffer.from(fileBase64, 'base64');
  } catch (e) {
    res.status(400).json({ error: 'invalid file data' }); return;
  }
  if (buf.length > MAX_BYTES) {
    res.status(400).json({ error: 'file is too large — this tool supports PDFs up to 3MB' });
    return;
  }
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
    res.status(400).json({ error: 'that doesn’t look like a PDF file' });
    return;
  }

  let text;
  try {
    const parsed = await pdfParse(buf);
    text = parsed.text;
  } catch (e) {
    res.status(400).json({ error: 'could not read text from that PDF', detail: String(e) });
    return;
  }

  const id = makeId();
  const pdfPath = 'uploads/' + id + '.pdf';

  try {
    // The uploaded PDF and the overrides.json entry are two separate
    // commits (two separate files via the Contents API) — write the PDF
    // first so the entry never points at a URL that 404s.
    await githubPutFile(pdfPath, fileBase64, 'Admin upload: ' + filename, undefined);

    const { current, sha } = await githubGetOverrides(overridesApi);
    var entry = {
      title: title,
      cat: cat || 'Uploaded documents',
      dated: new Date().toISOString().slice(0, 10),
      url: SITE_BASE_URL + pdfPath,
      html: textToHtml(text),
      updatedAt: new Date().toISOString()
    };
    current.uploadedGuides[id] = entry;
    current.updatedAt = new Date().toISOString();
    await githubPutFile(FILE_PATH, Buffer.from(JSON.stringify(current, null, 1)).toString('base64'),
      'Admin upload: guide ' + id, sha);
  } catch (e) {
    res.status(502).json({ error: e.message, detail: e.detail }); return;
  }

  res.status(200).json(Object.assign({ ok: true, id: id }, entry));
};
