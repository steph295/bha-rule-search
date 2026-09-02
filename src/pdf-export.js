/*
 * BHA Rules — PDF export.
 *
 * Every entry's `.html` already carries the site's own numbering markup
 * (<p class="l1"><span class="rn">45</span>…</p> etc, from parser.js /
 * extract_guides.py), so exporting is just: filter entries, group them into
 * the same heading hierarchy the site itself uses, print-style the l0–l3/rn
 * classes, and hand the result to the browser's native print-to-PDF — no
 * PDF library, no server, works identically on the public static site and
 * the admin tool.
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
    '.cover { text-align: center; padding-top: 30vh; page-break-after: always; }',
    '.cover .mark { font-family: Arial, Helvetica, sans-serif; font-size: 12pt; letter-spacing: .16em; color: #002f71; font-weight: 700; }',
    '.cover h1 { font-family: Arial, Helvetica, sans-serif; font-size: 27pt; margin: 14px 0 4px; color: #002f71; text-transform: uppercase; line-height: 1.2; }',
    '.cover .sub { font-size: 13pt; color: #3c4540; margin-top: 10px; }',
    '.cover .meta { font-size: 10pt; color: #7a8580; margin-top: 60px; }',
    '.group { page-break-before: always; }',
    '.group:first-of-type { page-break-before: avoid; }',
    // Chapter (depth 0) and its top-level sections (depth 1) share the same
    // bold underlined blue treatment — matches the BHA's own PDF, which
    // doesn't visually distinguish a chapter from its first-level sections.
    '.group h2, h2.section { font-family: Arial, Helvetica, sans-serif; font-size: 17pt; color: #002f71; border-bottom: 2px solid #002f71; padding-bottom: 7px; margin: 22px 0 10px; }',
    '.group:first-of-type > h2:first-child, h2.section:first-child { margin-top: 0; }',
    // Sub-sections (depth 2+) — smaller, dark, a thin dotted rule instead of
    // a bold blue one, same distinction the reader itself draws.
    'h3.subsection { font-family: Arial, Helvetica, sans-serif; font-size: 13pt; color: #16201b; border-bottom: 1px dotted #9db3a8; padding-bottom: 5px; margin: 18px 0 8px; }',
    // A run of numbered rules sharing one title (e.g. several "Scope and
    // application of the Rules" entries) is labelled once, not per rule.
    'h4.rule-title { font-family: Arial, Helvetica, sans-serif; font-size: 11.5pt; font-weight: 700; color: #16201b; margin: 14px 0 4px; }',
    '.doc-title { font-family: Arial, Helvetica, sans-serif; font-size: 13pt; font-weight: 700; color: #1b8ec9; margin: 20px 0 4px; }',
    '.entry { margin: 10px 0; }',
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
    'table { border-collapse: collapse; margin: 10px 0; font-size: 10pt; width: 100%; }',
    'th, td { border: 1px solid #cfd8d3; padding: 6px 9px; text-align: left; vertical-align: top; }',
    'th { background: #002f71; color: #fff; text-transform: uppercase; font-size: 9pt; letter-spacing: .02em; }',
    'tbody tr:nth-child(even) td { background: #f3f6f4; }',
    'ul { margin: 6px 0; padding-left: 22px; }',
    '.footer-note { font-family: Arial, Helvetica, sans-serif; font-size: 8.5pt; color: #8a958f; margin-top: 40px; }'
  ].join('\n');

  // Groups entries by their path (the breadcrumb of headings above them,
  // everything but their own title) into the same tree shape the reader's
  // own outline uses — so a chapter's PDF pages get the same section /
  // sub-section headings as the site, instead of one flat list of rules.
  function groupByPath(entries) {
    var root = { label: null, entries: [], children: [], _map: {} };
    entries.forEach(function (e) {
      var segs = (e.path || []).slice(0, -1);
      var node = root;
      segs.forEach(function (seg) {
        if (!seg) return;
        if (!node._map[seg]) {
          var child = { label: seg, entries: [], children: [], _map: {} };
          node._map[seg] = child;
          node.children.push(child);
        }
        node = node._map[seg];
      });
      node.entries.push(e);
    });
    return root;
  }

  // A run of consecutive numbered rules sharing one title (BHA's own data
  // often repeats the same title across several short rules) is labelled
  // once rather than per rule — matches the BHA's own PDF, which never
  // repeats a numbered rule's title at all. Un-coded entries (guides,
  // BHAGIs, codes) keep their own badge + title per entry as before.
  function renderTitledEntries(entries) {
    var html = '';
    var i = 0;
    while (i < entries.length) {
      var e0 = entries[i];
      if (e0.code) {
        var j = i + 1;
        while (j < entries.length && entries[j].code && entries[j].title === e0.title) j++;
        if (e0.title) html += '<h4 class="rule-title">' + esc(e0.title) + '</h4>';
        for (var k = i; k < j; k++) html += '<div class="entry">' + (entries[k].html || '') + '</div>';
        i = j;
      } else {
        var badge = e0.code || (e0.kind === 'bhagi' ? 'BHAGI' : e0.kind === 'guidedoc' ? 'Guide' : '');
        html += '<div class="entry"><div class="entry-head">' +
          (badge ? '<span class="code-badge">' + esc(badge) + '</span>' : '') +
          '<span class="entry-title">' + esc(e0.title) + '</span></div>' +
          (e0.html || '') + '</div>';
        i++;
      }
    }
    return html;
  }

  function renderPathTree(node, depth) {
    var html = '';
    if (node.label) {
      html += depth <= 1
        ? '<h2 class="section">' + esc(node.label) + '</h2>'
        : '<h3 class="subsection">' + esc(node.label) + '</h3>';
    }
    html += renderTitledEntries(node.entries);
    node.children.forEach(function (c) { html += renderPathTree(c, depth + 1); });
    return html;
  }

  function renderGroup(title, entries, isChapter) {
    if (!entries.length) return '';
    var html = '<div class="group"><h2>' + esc(title) + '</h2>';
    if (isChapter) {
      html += renderPathTree(groupByPath(entries), 1);
    } else {
      var lastDoc = null;
      entries.forEach(function (e) {
        if (e.doc && e.doc !== lastDoc && (isGuideEntry(e) || e.kind === 'code' || e.kind === 'guide')) {
          html += '<div class="doc-title">' + esc(e.doc) + '</div>';
          lastDoc = e.doc;
        }
        html += renderTitledEntries([e]);
      });
    }
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
      body += renderGroup(letter + ' — ' + (m ? m.title : 'Chapter ' + letter), chEntries, true);
    });
    if (opts.includeCodes) {
      var codeEntries = entries.filter(function (e) { return e.kind === 'code' || e.kind === 'guide'; });
      body += renderGroup('Codes & Guides', codeEntries, false);
    }
    if (opts.includeGuides) {
      var guideEntries = entries.filter(isGuideEntry);
      body += renderGroup('BHA General Instructions & Guide Library', guideEntries, false);
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
