#!/usr/bin/env node
/*
 * Pulls the current Rules of Racing from the official BHA rules site and, only
 * if it is complete and sane, saves it as data/book<id>.json (the file
 * build.js turns into the search data).
 *
 *   node tools/refresh-rules.js          fetch, check, save if changed
 *   node tools/refresh-rules.js --check  fetch and check, never write
 *
 * Exit code 0: fine (updated, or already up to date). Exit code 1: the fetch
 * failed or the result looked broken — nothing is overwritten, and the
 * scheduled GitHub Action fails so you get told.
 *
 * With GITHUB_OUTPUT set it also writes changed=true|false for the workflow.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../src/parser.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const API = process.env.BHA_RULES_API || 'https://rules.britishhorseracing.com';
const MIN_KEEP = 0.9; // a refresh with fewer than 90% of today's entries is treated as broken

function pickBook(books) {
  return (books || [])
    .filter((b) => b && b.published && !b.archived && (b.library_id || 0) > 0)
    .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))[0] || null;
}

async function getJSON(url, attempts = 3, timeoutMs = 120000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'bha-rule-search-refresh' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return JSON.parse(await r.text());
    } catch (e) {
      lastErr = e;
      console.log(`  attempt ${i}/${attempts} for ${url} failed: ${e.message}`);
      if (i < attempts) await new Promise((res) => setTimeout(res, 3000 * i));
    }
  }
  throw new Error(`could not fetch ${url}: ${lastErr && lastErr.message}`);
}

// What the rules actually say, not bookkeeping fields: BHA bumps updated_at for edits that
// change no wording, and we only want to commit when the content changes.
function contentHash(book) {
  const stable = {
    version: book.version, year: book.year, order: book.section_order,
    sections: (book.sections || []).map((s) => ({
      id: s.id, p: s.parent_id, o: s.order, t: s.type, slug: s.slug, title: s.title,
      h: s.highlighted, c: s.components, html: s.html
    }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function stats(book) {
  const parsed = P.parseBook(book);
  const rules = parsed.entries.filter((e) => e.kind === 'manual' && e.code);
  return {
    sections: (book.sections || []).length,
    entries: parsed.entries.length,
    rules: rules.length,
    manuals: parsed.manuals.length,
    terms: P.extractDefinitions(book).length
  };
}

// Returns a list of problems; empty means the new rulebook looks complete.
function validate(next, prev) {
  const problems = [];
  if (!next || !Array.isArray(next.sections) || !next.sections.length) problems.push('no sections in the downloaded rulebook');
  if (!next || !next.version) problems.push('no version number in the downloaded rulebook');
  if (!next || !next.year) problems.push('no effective date ("year") in the downloaded rulebook');
  if (problems.length) return problems;
  let s;
  try { s = stats(next); } catch (e) { return ['the rulebook could not be read by the parser: ' + e.message]; }
  if (!s.rules) problems.push('no numbered rules were found');
  if (s.manuals < 1) problems.push('no rule manuals (A, B, C…) were found');
  if (prev) {
    ['sections', 'entries', 'rules', 'manuals', 'terms'].forEach((k) => {
      if (prev[k] && s[k] < prev[k] * MIN_KEEP) {
        problems.push(`far fewer ${k} than before: ${s[k]} now vs ${prev[k]} saved (limit ${Math.round(MIN_KEEP * 100)}%)`);
      }
    });
  }
  return problems;
}

function localBook() {
  const files = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((f) => /^book\d+\.json$/.test(f)) : [];
  if (!files.length) return null;
  files.sort((a, b) => parseInt(b.slice(4), 10) - parseInt(a.slice(4), 10));
  return { file: path.join(DATA, files[0]), book: JSON.parse(fs.readFileSync(path.join(DATA, files[0]), 'utf8')) };
}

function setOutput(changed) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

async function refresh(opts) {
  const checkOnly = !!(opts && opts.checkOnly);
  console.log('Asking', API, 'for the published rulebook…');
  const books = await getJSON(API + '/api/books/');
  const meta = pickBook(books);
  if (!meta) throw new Error('no published rulebook was listed by the BHA site');
  console.log(`Latest: book ${meta.id}, version ${meta.version}, last edited ${meta.updated_at}`);

  const next = await getJSON(`${API}/api/books/${meta.id}?with=sections`, 3, 240000);
  const local = localBook();
  const prevStats = local ? stats(local.book) : null;
  const problems = validate(next, prevStats);
  if (problems.length) throw new Error('the downloaded rulebook looks broken, so nothing was changed:\n  - ' + problems.join('\n  - '));

  const hash = contentHash(next);
  const prevHash = local && (local.book._contentHash || contentHash(local.book));
  const nowStats = stats(next);
  console.log(`Downloaded: ${nowStats.sections} sections, ${nowStats.rules} numbered rules, ${nowStats.terms} definitions (saved copy: ${prevStats ? prevStats.rules + ' rules' : 'none'})`);

  if (local && local.book.id === next.id && prevHash === hash) {
    console.log(`Already up to date — version ${next.version}, effective ${next.year}.`);
    setOutput(false);
    return { changed: false, version: next.version };
  }

  next._sourceUpdatedAt = meta.updated_at;
  next._contentHash = hash;
  next._syncedAt = new Date().toISOString();
  if (checkOnly) {
    console.log(`Would update ${local ? 'from ' + local.book.version : ''} to version ${next.version} (effective ${next.year}). --check: nothing written.`);
    setOutput(false);
    return { changed: true, version: next.version, written: false };
  }
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, `book${next.id}.json`);
  fs.writeFileSync(file + '.tmp', JSON.stringify(next));
  fs.renameSync(file + '.tmp', file); // never leave a half-written file behind
  console.log(`Saved ${path.relative(ROOT, file)}: version ${next.version}, effective ${next.year}` + (local ? ` (was ${local.book.version}, ${local.book.year})` : ''));
  setOutput(true);
  return { changed: true, version: next.version, written: true };
}

module.exports = { refresh, validate, contentHash, stats, pickBook };

if (require.main === module) {
  refresh({ checkOnly: process.argv.includes('--check') }).catch((err) => {
    console.error('\nREFRESH FAILED: ' + err.message);
    setOutput(false);
    process.exit(1);
  });
}
