/*
 * BHA Rules — PDF export.
 *
 * Every entry's `.html` already carries the site's own numbering markup
 * (<p class="l1"><span class="rn">45</span>…</p> etc, from parser.js /
 * extract_guides.py), so exporting is just: filter entries, wrap them with
 * headings, print-style the same l0–l3/rn classes, and hand the result to
 * the browser's native print-to-PDF — no PDF library, no server, works
 * identically on the public static site and the admin tool.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function isGuideEntry(e) { return e.kind === 'bhagi' || e.kind === 'guidedoc'; }

  var PRINT_CSS = [
    '@page { margin: 2.1cm 1.9cm; }',
    'body { font-family: Arial, Helvetica, sans-serif; color: #16201b; font-size: 11.2pt; line-height: 1.55; margin: 0; }',
    '.cover { text-align: center; padding-top: 34vh; page-break-after: always; }',
    '.cover .mark { font-family: Arial, Helvetica, sans-serif; font-size: 12pt; letter-spacing: .16em; color: #002f71; font-weight: 700; }',
    '.cover h1 { font-family: Arial, Helvetica, sans-serif; font-size: 25pt; margin: 10px 0 4px; color: #002f71; }',
    '.cover .sub { font-size: 13pt; color: #3c4540; margin-top: 6px; }',
    '.cover .meta { font-size: 10pt; color: #7a8580; margin-top: 60px; }',
    '.group { page-break-before: always; }',
    '.group:first-of-type { page-break-before: avoid; }',
    '.group h2 { font-family: Arial, Helvetica, sans-serif; font-size: 17pt; color: #002f71; border-bottom: 2px solid #002f71; padding-bottom: 7px; margin: 0 0 6px; }',
    '.doc-title { font-family: Arial, Helvetica, sans-serif; font-size: 13pt; font-weight: 700; color: #1b8ec9; margin: 20px 0 4px; }',
    '.entry { margin: 14px 0; }',
    '.entry-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; }',
    '.code-badge { font-family: Arial, Helvetica, sans-serif; font-weight: 700; font-size: 10.5pt; color: #fff; background: #002f71; border-radius: 4px; padding: 1px 8px; white-space: nowrap; }',
    '.entry-title { font-family: Arial, Helvetica, sans-serif; font-weight: 700; font-size: 12pt; color: #16201b; }',
    'p { margin: 7px 0; position: relative; }',
    '.l1 { padding-left: 40px; }',
    '.l2 { padding-left: 72px; }',
    '.l3 { padding-left: 104px; }',
    '.l0 { color: #2b332e; }',
    '.rn { position: absolute; left: 0; color: #1b8ec9; font-weight: 700; }',
    '.l2 .rn { left: 36px; } .l3 .rn { left: 68px; }',
    'table { border-collapse: collapse; margin: 8px 0; font-size: 10pt; }',
    'th, td { border: 1px solid #9db3a8; padding: 4px 8px; text-align: left; vertical-align: top; }',
    'th { background: #e9f4fa; color: #002f71; }',
    'ul { margin: 6px 0; padding-left: 22px; }',
    '.footer-note { font-family: Arial, Helvetica, sans-serif; font-size: 8.5pt; color: #8a958f; margin-top: 40px; }'
  ].join('\n');

  function renderGroup(title, entries) {
    if (!entries.length) return '';
    var html = '<div class="group"><h2>' + esc(title) + '</h2>';
    var lastDoc = null;
    entries.forEach(function (e) {
      if (e.doc && e.doc !== lastDoc && (isGuideEntry(e) || e.kind === 'code' || e.kind === 'guide')) {
        html += '<div class="doc-title">' + esc(e.doc) + '</div>';
        lastDoc = e.doc;
      }
      var badge = (e.letter && e.num != null) ? '(' + e.letter + ')' + e.num : (e.code || (e.kind === 'bhagi' ? 'BHAGI' : e.kind === 'guidedoc' ? 'Guide' : ''));
      html += '<div class="entry">' +
        '<div class="entry-head">' + (badge ? '<span class="code-badge">' + esc(badge) + '</span>' : '') +
        '<span class="entry-title">' + esc(e.title) + '</span></div>' +
        (e.html || '') + '</div>';
    });
    html += '</div>';
    return html;
  }

  // opts: { chapters: ['A','F',...], includeCodes: bool, includeGuides: bool,
  //         version, dateLabel, title }
  function buildHtml(entries, manuals, opts) {
    opts = opts || {};
    var chapters = opts.chapters || [];
    var manualByLetter = {};
    (manuals || []).forEach(function (m) { manualByLetter[m.letter] = m; });

    var body = '';
    chapters.forEach(function (letter) {
      var m = manualByLetter[letter];
      var chEntries = entries.filter(function (e) { return e.letter === letter; })
        .sort(function (a, b) { return (a.num || 0) - (b.num || 0); });
      body += renderGroup(letter + ' — ' + (m ? m.title : 'Chapter ' + letter), chEntries);
    });
    if (opts.includeCodes) {
      var codeEntries = entries.filter(function (e) { return e.kind === 'code' || e.kind === 'guide'; });
      body += renderGroup('Codes & Guides', codeEntries);
    }
    if (opts.includeGuides) {
      var guideEntries = entries.filter(isGuideEntry);
      body += renderGroup('BHA General Instructions & Guide Library', guideEntries);
    }

    var chapterLabel = chapters.length ? chapters.join(', ') : 'none';
    var included = [];
    if (chapters.length) included.push('Chapters ' + chapterLabel);
    if (opts.includeCodes) included.push('Codes & Guides');
    if (opts.includeGuides) included.push('General Instructions & Guide Library');

    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(opts.title || 'BHA Rules of Racing') +
      '</title><style>' + PRINT_CSS + '</style></head><body>' +
      '<div class="cover"><div class="mark">BRITISH HORSERACING AUTHORITY</div>' +
      '<h1>' + esc(opts.title || 'Rules of Racing') + '</h1>' +
      '<div class="sub">Version ' + esc(opts.version || '') + (opts.dateLabel ? ' · ' + esc(opts.dateLabel) : '') + '</div>' +
      '<div class="meta">Generated from rules.britishhorseracing.com data · ' + esc(included.join(' + ') || 'no sections selected') +
      '<br>This export reflects the data loaded in your browser at generation time.</div></div>' +
      body +
      '<div class="footer-note">Unofficial export — always verify against the official BHA Rules of Racing.</div>' +
      '</body></html>';
  }

  // A hidden same-page iframe rather than window.open: it can't be blocked
  // by a pop-up blocker (there's no new window to block), which matters
  // more than the tiny extra complexity when this needs to work reliably
  // on whatever browser/extensions a steward happens to have tomorrow.
  var printFrame = null;
  function openAndPrint(html) {
    if (printFrame) printFrame.remove();
    printFrame = document.createElement('iframe');
    printFrame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    printFrame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(printFrame);
    var fired = false;
    var go = function () {
      if (fired) return;
      fired = true;
      try { printFrame.contentWindow.focus(); printFrame.contentWindow.print(); }
      catch (e) { alert('Could not open the print dialog: ' + e.message); }
    };
    printFrame.addEventListener('load', function () { setTimeout(go, 150); });
    printFrame.srcdoc = html;
    setTimeout(go, 1200); // fallback if load already fired
  }

  root.BHAPdfExport = { buildHtml: buildHtml, openAndPrint: openAndPrint };
})(typeof window !== 'undefined' ? window : this);
