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

// --fetch uses the same checked download as the scheduled Action (tools/refresh-rules.js),
// so a broken download can never replace the saved rulebook.
async function fetchLatest() {
  await require('./tools/refresh-rules.js').refresh();
  return loadLocal();
}

function loadLocal() {
  const files = fs.readdirSync(DATA).filter(f => /^book\d+\.json$/.test(f));
  if (!files.length) throw new Error('no data/book*.json found — run with --fetch');
  const file = files.sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10)).pop();
  console.log('Using', file);
  return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
}

// BHA's own "Table Of Penalties" appendix is a real, separate document in
// the same book — a set of Rule/Summary/Entry Point/Range tables, one per
// manual/code. It already flows through parseBook() as ordinary <table>
// entries (kind 'guide', doc 'Table Of Penalties'); this just builds the
// rule-code -> matching-rows index BHA's own site computes to show a
// "Penalty" quick-look on each rule, by reading the plain rule-code text
// each row already carries (e.g. "(E)14") — no invented data, no needing
// to resolve BHA's internal cross-reference IDs.
// <br> (BHA's own soft line-break inside a cell — see parser.js cleanHtml)
// needs to survive as a real line break, not get merged into the
// surrounding text like every other tag this strips.
function cellText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function extractPenalties(entries) {
  var byCode = {};
  entries.forEach(function (e) {
    if (e.doc !== 'Table Of Penalties') return;
    var rowRe = /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g;
    var m, lastRule = '', lastCode = '';
    while ((m = rowRe.exec(e.html))) {
      var ruleText = cellText(m[1]);
      var code = ruleText.replace(/[()]/g, '').trim();
      // A rule's later rows (offence breakdowns, "- 1st offence" etc.) often
      // leave the Rule cell blank on BHA's own site, relying on the row
      // above it — carry the last seen rule forward instead of dropping them.
      if (code) { lastRule = ruleText; lastCode = code; } else if (!lastCode) continue;
      if (!byCode[lastCode]) byCode[lastCode] = { sectionKey: 'Table Of Penalties::' + e.title, rows: [] };
      byCode[lastCode].rows.push({
        rule: lastRule,
        summary: cellText(m[2]),
        entryPoint: cellText(m[3]),
        range: cellText(m[4]),
        rc: cellText(m[5])
      });
    }
  });
  return byCode;
}

async function main() {
  const book = process.argv.includes('--fetch') ? await fetchLatest() : loadLocal();
  const parsed = P.parseBook(book);
  parsed.sourceUpdatedAt = book._sourceUpdatedAt || book.updated_at || null;
  parsed.syncedAt = book._syncedAt || null; // when this copy was last pulled from BHA (set by tools/refresh-rules.js)

  // slim snapshot: search text is rebuilt in the browser from html
  const penaltyByCode = extractPenalties(parsed.entries);
  const snapshot = {
    bookId: parsed.bookId,
    version: parsed.version,
    publishedAt: parsed.publishedAt,
    year: parsed.year,
    sourceUpdatedAt: parsed.sourceUpdatedAt,
    syncedAt: parsed.syncedAt,
    manuals: parsed.manuals,
    entries: parsed.entries.map(e => ({
      id: e.id, code: e.code, num: e.num, kind: e.kind, doc: e.doc,
      letter: e.letter, title: e.title, path: e.path, html: e.html, isNew: e.isNew || false,
      chapterSlug: e.chapterSlug || undefined,
      penalties: (e.code && penaltyByCode[e.code]) || undefined
    }))
  };
  const penaltyRuleCount = snapshot.entries.filter(e => e.penalties).length;
  console.log(`penalty table cross-referenced to ${penaltyRuleCount} rules`);

  const read = f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
  // <-escape so "</script>" can never terminate the inline blocks
  const snapJson = JSON.stringify(snapshot).replace(/</g, '\\u003c');

  const html = read('template.html')
    .replace('{{STYLES}}', () => fs.readFileSync(path.join(ROOT, 'tokens.css'), 'utf8') + '\n' + read('styles.css'))
    .replace('{{PARSER}}', () => read('parser.js'))
    .replace('{{PDFEXPORT}}', () => read('pdf-export.js'))
    .replace('{{APP}}', () => read('app.js'))
    .replace('{{SNAPSHOT}}', () => snapJson);

  fs.writeFileSync(path.join(ROOT, 'index.html'), html);
  const kb = (fs.statSync(path.join(ROOT, 'index.html')).size / 1024).toFixed(0);
  console.log(`index.html built — ${kb} KB, ${parsed.entries.length} entries, rules v${parsed.version}`);

  // Plain-JSON copy of the same rulebook snapshot embedded in index.html.
  // Used by the admin tool (and anything else) that wants the parsed
  // rulebook without scraping it out of the built page.
  fs.writeFileSync(path.join(ROOT, 'rules.json'), JSON.stringify(snapshot));
  const rkb = (fs.statSync(path.join(ROOT, 'rules.json')).size / 1024).toFixed(0);
  console.log(`rules.json written — ${rkb} KB`);

  // The guide library (PDF extracts) ships as a sibling file the app fetches
  // after first paint, so the rulebook stays instantly searchable.
  const guidesSrc = path.join(DATA, 'guides.json');
  if (fs.existsSync(guidesSrc)) {
    fs.copyFileSync(guidesSrc, path.join(ROOT, 'guides.json'));
    const g = JSON.parse(fs.readFileSync(guidesSrc, 'utf8'));
    const gkb = (fs.statSync(guidesSrc).size / 1024).toFixed(0);
    const bh = g.entries.filter(e => e.kind === 'bhagi').length;
    console.log(`guides.json copied — ${gkb} KB, ${g.entries.length} entries ` +
      `(${bh} BHAGI instructions) from ${g.documents} documents`);
  } else {
    console.log('guides.json not found — run: python3 tools/extract_guides.py');
  }

  // Glossary: real defined terms + definitions parsed straight out of the
  // rulebook's own "Definitions" chapter (see parser.js extractDefinitions).
  const definitions = P.extractDefinitions(book);
  const defsChapter = (book.sections || []).filter(sec => sec.type === 'chapter' && String(sec.title || '').trim().toLowerCase() === 'definitions')[0];
  fs.writeFileSync(path.join(ROOT, 'definitions.json'), JSON.stringify({ bookId: parsed.bookId, chapterSlug: defsChapter ? defsChapter.slug : null, terms: definitions }));
  const dkb = (fs.statSync(path.join(ROOT, 'definitions.json')).size / 1024).toFixed(0);
  console.log(`definitions.json written — ${dkb} KB, ${definitions.length} terms`);

  // Tiny freshness file for pages that don't load the whole rulebook (the /ask page's
  // "Rules last updated" line): which version, its effective date, and when we last synced it.
  fs.writeFileSync(path.join(ROOT, 'rules-meta.json'), JSON.stringify({
    bookId: parsed.bookId, version: parsed.version, effective: parsed.year,
    sourceUpdatedAt: parsed.sourceUpdatedAt, syncedAt: parsed.syncedAt
  }));
  console.log(`rules-meta.json written — v${parsed.version}, effective ${parsed.year}, synced ${parsed.syncedAt || 'unknown'}`);
}

main().catch(err => { console.error(err); process.exit(1); });
