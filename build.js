#!/usr/bin/env node
/*
 * Builds the single-file app: index.html = template + inline CSS/JS +
 * embedded pre-parsed rules snapshot.
 *
 *   node build.js            — build from data/book34.json
 *   node build.js --fetch    — refetch the latest rulebook from the BHA API first
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./src/parser.js');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const API = 'https://rules.britishhorseracing.com';

async function fetchLatest() {
  const books = await (await fetch(API + '/api/books/')).json();
  const book = books
    .filter(b => b.published && !b.archived && (b.library_id || 0) > 0)
    .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))[0];
  if (!book) throw new Error('no published rulebook found');
  console.log(`Fetching book ${book.id} (v${book.version}, published ${book.published_at})…`);
  const full = await (await fetch(`${API}/api/books/${book.id}?with=sections`)).json();
  full._sourceUpdatedAt = book.updated_at;
  fs.writeFileSync(path.join(DATA, `book${book.id}.json`), JSON.stringify(full));
  return full;
}

function loadLocal() {
  const files = fs.readdirSync(DATA).filter(f => /^book\d+\.json$/.test(f));
  if (!files.length) throw new Error('no data/book*.json found — run with --fetch');
  const file = files.sort().pop();
  console.log('Using', file);
  return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
}

async function main() {
  const book = process.argv.includes('--fetch') ? await fetchLatest() : loadLocal();
  const parsed = P.parseBook(book);
  parsed.sourceUpdatedAt = book._sourceUpdatedAt || book.updated_at || null;

  // slim snapshot: search text is rebuilt in the browser from html
  const snapshot = {
    bookId: parsed.bookId,
    version: parsed.version,
    publishedAt: parsed.publishedAt,
    year: parsed.year,
    sourceUpdatedAt: parsed.sourceUpdatedAt,
    manuals: parsed.manuals,
    entries: parsed.entries.map(e => ({
      id: e.id, code: e.code, num: e.num, kind: e.kind, doc: e.doc,
      letter: e.letter, title: e.title, path: e.path, html: e.html
    }))
  };

  const read = f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
  // <-escape so "</script>" can never terminate the inline blocks
  const snapJson = JSON.stringify(snapshot).replace(/</g, '\\u003c');

  const html = read('template.html')
    .replace('{{STYLES}}', () => read('styles.css'))
    .replace('{{PARSER}}', () => read('parser.js'))
    .replace('{{APP}}', () => read('app.js'))
    .replace('{{SNAPSHOT}}', () => snapJson);

  fs.writeFileSync(path.join(ROOT, 'index.html'), html);
  const kb = (fs.statSync(path.join(ROOT, 'index.html')).size / 1024).toFixed(0);
  console.log(`index.html built — ${kb} KB, ${parsed.entries.length} entries, rules v${parsed.version}`);
}

main().catch(err => { console.error(err); process.exit(1); });
