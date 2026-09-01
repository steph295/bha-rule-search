/* BHA Rules Search — app logic. Runs against the index produced by parser.js. */
(function () {
  'use strict';

  var P = window.BHAParser;
  var API_HOST = 'https://rules.britishhorseracing.com';
  var LS_KEY = 'bha-rules-index-v1';
  var LS_CHECK = 'bha-rules-lastcheck-v1';
  var CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // background version check throttle
  var PAGE = 50;

  var GUIDES_URL = 'guides.json';
  var LS_GUIDES = 'bha-guides-v1';
  var OVERRIDES_URL = 'overrides.json';
  var LS_HISTORY = 'bha-history-v1';
  var GLOSSARY_URL = 'definitions.json';
  var LS_GLOSSARY = 'bha-glossary-v1';

  // Same key logic as the admin tool (admin/admin.js) — must stay identical
  // so an edit saved there lands on the right entry here.
  function entryKey(e) { return e.code || (e.doc + '::' + e.title); }

  var state = {
    data: null,        // {version, publishedAt, manuals, entries, sourceUpdatedAt}
    source: 'none',    // snapshot | cache | live | pasted
    vocab: [],         // unique words for fuzzy matching
    corpus: '',        // all text concatenated, for cheap "does this word exist" checks
    shown: PAGE,
    activeIdx: -1,
    lastResults: [],
    lastTerms: [],
    guides: null,      // {source, documents, entries}
    guidesState: 'idle', // idle | loading | ready | failed
    tab: 'all',        // all | rules | guides | new
    sub: 'all',        // all | bhagi  (within the guides tab)
    overrides: null,   // {key: {title, html}} published by the admin tool, once loaded
    definitionOverrides: null, // {termId: {html}} published edits to glossary definitions
    bookOverrides: null, // {'rules'|'guides'|'bhagi': {title, whatsNew}} published book-level edits
    customDefinitions: null, // {id: {term, html}} admin-added glossary terms not in BHA's own chapter
    uploadedGuides: null, // {id: {title, cat, dated, url, html}} admin-uploaded Guide Library PDFs
    history: null,     // [{label, url}] dated rulebook snapshots, newest first
    historyState: 'idle', // idle | loading | ready | failed
    mode: 'search',    // search | reader
    readerBook: null,  // 'rules' | 'guides' | 'bhagi' — which book the reader is showing
    glossary: null,      // {bookId, terms: [{id, term, html, slug}]}
    glossaryState: 'idle', // idle | loading | ready | failed
    glossaryRe: null,      // compiled longest-match-first regex over every term
    glossaryByLower: null, // lowercased term -> term object
    activeDefTerm: null,   // id of the term currently shown in the reader's definitions panel
    readerNewOnly: false   // "Show new only" toggle within the reader's outline search
  };

  // Which tab an entry belongs to. Rulebook entries (manual/code/guide) come
  // from rules.britishhorseracing.com; bhagi/guidedoc come from the PDF library.
  function isGuideEntry(e) { return e.kind === 'bhagi' || e.kind === 'guidedoc'; }

  function inTab(e, tab, sub) {
    if (tab === 'new') return !!e.isNew;
    if (tab === 'rules') return !isGuideEntry(e);
    if (tab === 'bhagi') return e.kind === 'bhagi';
    if (tab === 'guides') {
      if (!isGuideEntry(e)) return false;
      return sub === 'bhagi' ? e.kind === 'bhagi' : true;
    }
    return true;
  }

  var $ = function (id) { return document.getElementById(id); };
  var q = $('q'), results = $('results'), meta = $('meta'), status = $('status');
  var HOME_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5L8 2.5l5.5 5"></path><path d="M4 6.5V13h8V6.5"></path></svg>';

  // ---------------------------------------------------------------- boot

  function loadSnapshot() {
    var el = $('bha-snapshot');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return obj && obj.entries && obj.entries.length ? obj : null;
    } catch (e) { return null; }
  }

  function saveCache(data) {
    try {
      var slim = {
        bookId: data.bookId, version: data.version, publishedAt: data.publishedAt,
        year: data.year, sourceUpdatedAt: data.sourceUpdatedAt, manuals: data.manuals,
        entries: data.entries.map(function (e) {
          return { id: e.id, code: e.code, num: e.num, kind: e.kind, doc: e.doc, letter: e.letter, title: e.title, path: e.path, html: e.html, isNew: e.isNew || false };
        })
      };
      localStorage.setItem(LS_KEY, JSON.stringify(slim));
    } catch (e) { /* quota — memory cache still works */ }
  }

  function adopt(data, source) {
    state.data = data;
    state.source = source;
    // keep any already-loaded guides alongside the (re)loaded rulebook
    if (state.guides) {
      mergeGuides();
    } else {
      prepareEntries(data.entries);
      buildVocab();
    }
    applyOverrides();
    renderStatus();
    renderTabs();
    runSearch();
  }

  // ---- admin overrides (published by admin/admin.js) --------------------

  // Overrides are a thin, public, unauthenticated patch layer: the admin
  // tool commits {key: {title, html}} entries here, and every visitor's
  // client applies them on top of whichever snapshot they already loaded.
  // No build step, no redeploy — an edit is live as soon as this file is.
  function loadOverrides() {
    fetch(OVERRIDES_URL, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : { overrides: {}, definitionOverrides: {} }; })
      .then(function (j) {
        state.overrides = (j && j.overrides) || {};
        state.definitionOverrides = (j && j.definitionOverrides) || {};
        state.bookOverrides = (j && j.bookOverrides) || {};
        state.customDefinitions = (j && j.customDefinitions) || {};
        state.uploadedGuides = (j && j.uploadedGuides) || {};
        applyOverrides();
        applyDefinitionOverrides();
        mergeCustomDefinitions();
        if (mergeUploadedGuides() && state.guidesState === 'ready') { mergeGuides(); refreshView(); }
        if (Object.keys(state.overrides).length) refreshView();
        if ((Object.keys(state.definitionOverrides).length || Object.keys(state.customDefinitions).length) && state.mode === 'reader') renderIdle();
        if (Object.keys(state.bookOverrides).length && state.mode !== 'reader') renderIdle();
      })
      .catch(function () { /* no overrides file yet — fine */ });
  }

  function applyDefinitionOverrides() {
    if (!state.definitionOverrides || !state.glossary) return;
    state.glossary.terms.forEach(function (t) {
      var o = state.definitionOverrides[t.id];
      if (o && o.html) t.html = o.html;
    });
  }

  // Admin-added terms that aren't part of BHA's own Definitions chapter —
  // appended to the same glossary term list so they're matched and shown
  // exactly like an official term. Additive and idempotent: safe to call
  // whenever either the glossary or the overrides file finishes loading,
  // in either order.
  function mergeCustomDefinitions() {
    if (!state.customDefinitions || !state.glossary) return;
    var have = {};
    state.glossary.terms.forEach(function (t) { have[t.id] = true; });
    var added = false;
    Object.keys(state.customDefinitions).forEach(function (id) {
      if (have[id]) return;
      var c = state.customDefinitions[id];
      state.glossary.terms.push({ id: id, term: c.term, html: c.html, slug: id });
      added = true;
    });
    if (added) buildGlossaryMatcher();
  }

  function applyOverrides() {
    if (!state.overrides || !state.data) return;
    state.data.entries.forEach(function (e) {
      var o = state.overrides[entryKey(e)];
      if (!o) return;
      if (o.title) e.title = o.title;
      if (o.html) { e.html = o.html; e.plain = undefined; }
      var flag = o.flag === 'not-new' ? 'none' : o.flag;
      if (flag === 'new') { e.isNew = true; e.isUpdated = false; }
      else if (flag === 'updated') { e.isNew = false; e.isUpdated = true; }
      else if (flag === 'none') { e.isNew = false; e.isUpdated = false; }
    });
    prepareEntries(state.data.entries);
    buildVocab();
  }

  // ---- guides (PDF library) -------------------------------------------

  // Merge the guide entries into the searchable set. Ids must stay equal to
  // array indices — expanding a card looks the entry up by index.
  function mergeGuides() {
    if (!state.data || !state.guides) return;
    var base = state.data.entries.filter(function (e) { return !isGuideEntry(e); });
    var merged = base.concat(state.guides.entries.map(function (g) {
      return {
        code: g.code || null,
        num: null,
        kind: g.kind === 'bhagi' ? 'bhagi' : 'guidedoc',
        doc: g.doc,
        cat: g.cat,
        letter: null,
        title: g.title,
        dated: g.dated || '',
        url: g.url,
        page: g.page || 1,
        path: [g.cat],
        html: g.html
      };
    }));
    state.data.entries = merged;
    prepareEntries(merged);
    buildVocab();
    applyOverrides();
  }

  // Admin-uploaded PDFs, appended into the same guides.entries array
  // mergeGuides() reads — additive and idempotent (tagged with _uploadId so
  // it's safe to call again after either the glossary or the overrides file
  // finishes loading, in either order). Not run through any rule-numbering
  // parser: each upload becomes exactly one entry, matching what was chosen
  // for this feature (a Guide Library document, not a structured book).
  function mergeUploadedGuides() {
    if (!state.uploadedGuides || !state.guides) return false;
    var have = {};
    state.guides.entries.forEach(function (g) { if (g._uploadId) have[g._uploadId] = true; });
    var added = false;
    Object.keys(state.uploadedGuides).forEach(function (id) {
      if (have[id]) return;
      var u = state.uploadedGuides[id];
      state.guides.entries.push({
        code: null, kind: 'guide', doc: u.title, cat: u.cat || 'Uploaded documents',
        title: u.title, dated: u.dated || '', url: u.url, page: 1, html: u.html, _uploadId: id
      });
      added = true;
    });
    if (added) {
      var docs = {};
      state.guides.entries.forEach(function (g) { docs[g.doc] = 1; });
      state.guides.documents = Object.keys(docs).length;
    }
    return added;
  }

  function prepareEntries(entries) {
    entries.forEach(function (e, i) {
      e.id = i;
      if (!e.plain) e.plain = P.toText(e.html);
      e.text = (e.title + ' ' + (e.path || []).join(' ') + ' ' + e.doc + ' ' +
        (e.code || '') + ' ' + e.plain).toLowerCase().replace(/\s+/g, ' ').trim();
    });
  }

  function loadGuides() {
    if (state.guidesState === 'loading' || state.guidesState === 'ready') return;
    state.guidesState = 'loading';

    var cached = null;
    try {
      var raw = localStorage.getItem(LS_GUIDES);
      if (raw) cached = JSON.parse(raw);
    } catch (e) { /* ignore */ }

    if (cached && cached.entries && cached.entries.length) {
      state.guides = cached;
      state.guidesState = 'ready';
      mergeUploadedGuides();
      mergeGuides();
      refreshView();
    }

    fetch(GUIDES_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.entries || !j.entries.length) throw new Error('empty guides file');
        state.guides = j;
        state.guidesState = 'ready';
        mergeUploadedGuides();
        mergeGuides();
        refreshView();
        try { localStorage.setItem(LS_GUIDES, JSON.stringify(j)); } catch (e) { /* quota */ }
      })
      .catch(function () {
        if (state.guidesState !== 'ready') state.guidesState = 'failed';
        renderTabs();
      });
  }

  function refreshView() {
    renderTabs();
    runSearch();
  }

  // ---- glossary (real defined terms, parsed from the rulebook's own
  // "Definitions" chapter — see parser.js extractDefinitions) -----------

  function buildGlossaryMatcher() {
    var terms = state.glossary.terms;
    var byLower = {};
    terms.forEach(function (t) { byLower[t.term.toLowerCase()] = t; });
    // longest-first so "Recognised Racing Authority" wins over "Authority"
    var sorted = terms.slice().sort(function (a, b) { return b.term.length - a.term.length; });
    var pattern = sorted.map(function (t) { return escRe(t.term); }).join('|');
    state.glossaryRe = pattern ? new RegExp('\\b(' + pattern + ')\\b', 'gi') : null;
    state.glossaryByLower = byLower;
  }

  // Wraps every occurrence of a known defined term in matching text nodes
  // with a clickable span — safe against the surrounding markup because it
  // only ever touches text between ">" and "<", same trick as highlightHtml.
  // Trailing icon on every defined term — the rulebook's own prose also uses
  // plain <u> underlines for sub-headings (e.g. "Reserving a name"), which
  // look identical to the dotted defterm underline at a glance. The icon is
  // the affordance that says "this one is clickable", not just the underline.
  var DEFTERM_ICON = '<svg class="defterm-icon" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.75" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.25V11.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="4.85" r="0.95" fill="currentColor"/></svg>';
  function glossarize(html) {
    var re = state.glossaryRe;
    if (!re) return html;
    return html.replace(/>([^<]+)</g, function (_, txt) {
      return '>' + txt.replace(re, function (match) {
        var t = state.glossaryByLower[match.toLowerCase()];
        return t ? '<span class="defterm" data-term-id="' + t.id + '">' + match + DEFTERM_ICON + '</span>' : match;
      }) + '<';
    });
  }

  // The admin can flag individual lines (not just a whole rule) as New or
  // Updated — a data-flag attribute set on that <p> in the published html.
  // Consecutive lines sharing a flag are shown under one merged tag rather
  // than repeating a pill per line, since an editor flags a run of related
  // clauses together, not each one separately.
  function groupFlaggedLines(html) {
    if (html.indexOf('data-flag') === -1) return html;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var out = document.createElement('div');
    var group = null, groupFlag = null;
    Array.prototype.forEach.call(tmp.childNodes, function (node) {
      var flag = node.nodeType === 1 ? node.getAttribute('data-flag') : null;
      if (flag && flag === groupFlag) { group.appendChild(node); return; }
      group = null; groupFlag = null;
      if (flag) {
        groupFlag = flag;
        group = document.createElement('div');
        group.className = 'flagged-group ' + flag;
        var tag = document.createElement('div');
        tag.className = 'flagged-group-tag';
        tag.innerHTML = flag === 'new' ? NEW_PILL : UPDATED_PILL;
        group.appendChild(tag);
        group.appendChild(node);
        out.appendChild(group);
        return;
      }
      out.appendChild(node);
    });
    return out.innerHTML;
  }

  function loadGlossary() {
    if (state.glossaryState === 'loading' || state.glossaryState === 'ready') return;
    state.glossaryState = 'loading';

    var cached = null;
    try {
      var raw = localStorage.getItem(LS_GLOSSARY);
      if (raw) cached = JSON.parse(raw);
    } catch (e) { /* ignore */ }
    if (cached && cached.terms && cached.terms.length) {
      state.glossary = cached;
      state.glossaryState = 'ready';
      buildGlossaryMatcher();
      applyDefinitionOverrides();
      mergeCustomDefinitions();
    }

    fetch(GLOSSARY_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.terms || !j.terms.length) throw new Error('empty glossary file');
        state.glossary = j;
        state.glossaryState = 'ready';
        buildGlossaryMatcher();
        applyDefinitionOverrides();
        mergeCustomDefinitions();
        if (state.mode === 'reader') renderIdle();
        try { localStorage.setItem(LS_GLOSSARY, JSON.stringify(j)); } catch (e) { /* quota */ }
      })
      .catch(function () {
        if (state.glossaryState !== 'ready') state.glossaryState = 'failed';
      });
  }

  function buildVocab() {
    var seen = Object.create(null);
    var words = [];
    var chunks = [];
    state.data.entries.forEach(function (e) {
      chunks.push(e.text);
      var m = e.text.split(/[^a-z0-9']+/);
      for (var i = 0; i < m.length; i++) {
        var w = m[i];
        if (w.length >= 4 && w.length <= 24 && !seen[w]) { seen[w] = 1; words.push(w); }
      }
    });
    state.vocab = words;
    state.corpus = chunks.join('\n');
  }

  // ------------------------------------------------------------- fuzzy

  // Damerau-Levenshtein (optimal string alignment), early-exits past `max`.
  function editDistanceAtMost(a, b, max) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    var prevPrev = [], prev = [], cur = [], i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var rowMin = cur[0];
      for (j = 1; j <= lb; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          cur[j] = Math.min(cur[j], prevPrev[j - 2] + 1);
        }
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      var t = prevPrev; prevPrev = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }

  function fuzzyExpand(token) {
    var max = token.length >= 7 ? 2 : 1;
    var hits = [];
    for (var i = 0; i < state.vocab.length; i++) {
      var w = state.vocab[i];
      var d = editDistanceAtMost(token, w, max);
      if (d <= max) {
        hits.push({ w: w, d: d });
        if (hits.length > 40) break;
      }
    }
    hits.sort(function (a, b) { return a.d - b.d || a.w.length - b.w.length; });
    return hits.slice(0, 8).map(function (h) { return h.w; });
  }

  // ------------------------------------------------------------- search

  // Parse a rule-code query: "f45", "(F)45", "f 45", "f45.5", "45", "f"
  function parseCodeQuery(tokens) {
    var t = tokens.slice();
    if (t[0] === 'rule' || t[0] === 'rules') t.shift();
    if (!t.length) return null;
    var first = t[0];
    // join "f" + "45"
    if (/^\(?[a-z]\)?$/.test(first) && t[1] && /^\d/.test(t[1])) {
      first = first + t[1];
      t.splice(0, 2);
    } else {
      t.shift();
    }
    // letter + number, optional suffix letter and sub-clause: f45, (F)45, f45a, f45.3
    var m = /^\(?([a-z])\)?[)\-]?(\d{1,3})?([a-z])?(?:\.(\d+(?:\.\d+)*))?$/.exec(first);
    if (m && (m[2] || /^\(?[a-z]\)?$/.test(first))) {
      return { letter: m[1].toUpperCase(), num: m[2] ? parseInt(m[2], 10) : null, suffix: m[3] || null, sub: m[4] || null, rest: t };
    }
    var n = /^(\d{1,3})([a-z])?(?:\.(\d+(?:\.\d+)*))?$/.exec(first);
    if (n) return { letter: null, num: parseInt(n[1], 10), suffix: n[2] || null, sub: n[3] || null, rest: t };
    return null;
  }

  function keywordScore(entry, token) {
    var idx = entry.text.indexOf(token);
    if (idx === -1) return 0;
    var score = 6;
    var boundary = new RegExp('(^|[^a-z0-9])' + escRe(token));
    if (boundary.test(entry.text)) score += 15;
    if (entry.title.toLowerCase().indexOf(token) !== -1) score += 40;
    // frequency nudge
    var count = entry.text.split(token).length - 1;
    score += Math.min(count, 5) * 2;
    return score;
  }

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function search(raw) {
    var qs = raw.trim().toLowerCase();
    if (!qs || !state.data) return { entries: [], terms: [], mode: 'idle' };
    var entries = state.data.entries;
    var tokens = qs.split(/\s+/).filter(Boolean);
    var terms = [];
    var scored = [];

    var pool = entries;
    var codeMatched = false;
    var exactHit = false;

    // ---- BHAGI codes: "BHAGI 1.2", "bhagi1.2", "bhagi 4" (whole section),
    // "bhagi" (all), and a bare "1.2" which also matches BHAGI 1.2.
    var bhagiOnly = /^bhagis?\b/.test(qs);
    var bm = /^bhagis?\s*(\d+)(?:\.(\d+))?$/.exec(qs);
    if (!bm && bhagiOnly && /^bhagis?$/.test(qs.trim())) bm = ['', null, null];
    if (!bm && !bhagiOnly) {
      var bare = /^(\d+)\.(\d+)$/.exec(qs.trim());
      if (bare) bm = ['', bare[1], bare[2]];
    }
    if (bm) {
      var sec = bm[1], sub = bm[2];
      var hits = entries.filter(function (e) {
        if (e.kind !== 'bhagi' || !e.code) return false;
        if (sec == null) return true;
        var c = /^BHAGI\s+(\d+)\.(\d+)$/.exec(e.code);
        if (!c) return false;
        if (c[1] !== String(sec)) return false;
        return sub == null || c[2] === String(sub);
      }).sort(function (a, b) {
        var ca = /(\d+)\.(\d+)/.exec(a.code), cb = /(\d+)\.(\d+)/.exec(b.code);
        return (+ca[1] - +cb[1]) || (+ca[2] - +cb[2]);
      });
      if (hits.length) {
        codeMatched = true;
        exactHit = bhagiOnly && sub != null && hits.length === 1;
        if (sec != null) terms.push(sec + (sub != null ? '.' + sub : ''));
        hits.forEach(function (e, i) { scored.push({ e: e, s: 20000 - i }); });
        if (bhagiOnly) {
          return { entries: hits, terms: terms, mode: 'code', exact: exactHit };
        }
      }
    }

    var code = parseCodeQuery(tokens);

    if (code && code.letter && code.num != null) {
      var exact = entries.filter(function (e) { return e.letter === code.letter && e.num === code.num; });
      var prefix = entries.filter(function (e) {
        return e.letter === code.letter && e.num != null && e.num !== code.num && String(e.num).indexOf(String(code.num)) === 0;
      }).sort(function (a, b) { return a.num - b.num; });
      if (exact.length || prefix.length) {
        codeMatched = true;
        exactHit = exact.length > 0;
        terms.push(code.letter.toLowerCase() + code.num);
        if (code.suffix) terms.push(code.num + code.suffix);
        if (code.sub) terms.push(code.num + (code.suffix || '') + '.' + code.sub);
        var seq = exact.concat(prefix);
        if (code.rest.length) {
          // keywords narrow the code matches, falling back to code-only
          var kw = filterKeywords(seq, code.rest, terms);
          if (kw.length) seq = kw.map(function (s) { return s.e; });
        }
        seq.forEach(function (e, i) { scored.push({ e: e, s: 10000 - i }); });
      }
    } else if (code && code.letter && code.num == null && tokens.length === 1) {
      // bare letter → browse that manual in order
      var man = entries.filter(function (e) { return e.letter === code.letter && e.num != null; })
        .sort(function (a, b) { return a.num - b.num; });
      if (man.length) {
        man.forEach(function (e, i) { scored.push({ e: e, s: 10000 - i }); });
        codeMatched = true;
      }
    } else if (code && !code.letter && code.num != null && tokens.length === 1) {
      // bare number → that rule in every manual
      var anyman = entries.filter(function (e) { return e.num === code.num; });
      if (anyman.length) {
        anyman.forEach(function (e) { scored.push({ e: e, s: 9000 }); });
        terms.push(String(code.num));
        codeMatched = true;
      }
    }

    if (!codeMatched) {
      var kws = filterKeywords(pool, tokens, terms);
      kws.forEach(function (k) { scored.push(k); });
    }

    scored.sort(function (a, b) { return b.s - a.s; });
    return {
      entries: scored.map(function (x) { return x.e; }),
      terms: terms,
      mode: codeMatched ? 'code' : 'keyword',
      exact: exactHit
    };
  }

  // AND-match tokens against entries; fuzzy-expands tokens that match nothing.
  function filterKeywords(pool, tokens, termsOut) {
    var expansions = tokens.map(function (tok) {
      if (state.corpus.indexOf(tok) !== -1) { pushTerm(termsOut, tok); return [tok]; }
      if (tok.length >= 4) {
        var fz = fuzzyExpand(tok);
        fz.forEach(function (w) { pushTerm(termsOut, w); });
        if (fz.length) return fz;
      }
      pushTerm(termsOut, tok);
      return [tok];
    });
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      var e = pool[i], total = 0, ok = true;
      for (var t = 0; t < expansions.length; t++) {
        var best = 0;
        for (var x = 0; x < expansions[t].length; x++) {
          var s = keywordScore(e, expansions[t][x]);
          // exact token scores full; fuzzy alternates score slightly less
          if (expansions[t][x] !== tokens[t]) s = s * 0.8;
          if (s > best) best = s;
        }
        if (!best) { ok = false; break; }
        total += best;
      }
      if (ok) {
        if (e.kind === 'manual') total += 25; // actual rules above guides/codes
        out.push({ e: e, s: total });
      }
    }
    return out;
  }

  function pushTerm(arr, t) { if (arr.indexOf(t) === -1) arr.push(t); }

  // ------------------------------------------------------------- render

  // BHA's own site numbers a rule with a bare number only (30, 31, 32…) —
  // it never repeats the manual letter on the number itself, relying on
  // the surrounding heading/breadcrumb for that context instead. The
  // "(A)"/"(C)" prefix was this app's own invention; dropped so the
  // badge matches BHA's real format.
  function dispCode(e) {
    if (e.kind === 'bhagi') return e.code || 'BHAGI';
    if (e.kind === 'guidedoc') return e.cat === 'BHA General Instructions (BHAGIs)' ? 'BHAGI' : 'Guide';
    if (e.code) return String(e.num);
    // Same bare-number convention as a manual rule — paragraph numbers in a
    // standalone Code/Guide restart per document (see parser.js), but BHA's
    // own site still shows just the number, no "¶" ornament of our own.
    if (e.num != null) return String(e.num);
    if (e.kind === 'code') return 'Code';
    if (e.kind === 'guide') return 'Guide';
    return 'Text';
  }

  function codeClass(e) {
    if (e.kind === 'bhagi') return 'code bhagi';
    if (e.kind === 'guidedoc') return 'code guidedoc';
    return e.code ? 'code' : 'code kind';
  }

  function highlight(escaped, terms) {
    if (!terms.length) return escaped;
    var re = new RegExp('(' + terms.map(escRe).join('|') + ')', 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
  }

  // highlight only inside text nodes of trusted rule html
  function highlightHtml(html, terms) {
    if (!terms.length) return html;
    var re = new RegExp('(' + terms.map(escRe).join('|') + ')', 'gi');
    return html.replace(/>([^<]+)</g, function (_, txt) {
      return '>' + txt.replace(re, '<mark>$1</mark>') + '<';
    });
  }

  function excerpt(e, terms) {
    var plain = e.plain || '';
    var lower = plain.toLowerCase();
    var pos = -1;
    for (var i = 0; i < terms.length; i++) {
      var p = lower.indexOf(terms[i]);
      if (p !== -1 && (pos === -1 || p < pos)) pos = p;
    }
    var start = pos === -1 ? 0 : Math.max(0, pos - 90);
    // snap to a word boundary
    if (start > 0) { var sp = plain.indexOf(' ', start); if (sp !== -1 && sp < start + 20) start = sp + 1; }
    var slice = plain.slice(start, start + 230);
    return (start > 0 ? '…' : '') + slice + (start + 230 < plain.length ? '…' : '');
  }

  function renderStatus() {
    var d = state.data;
    if (!d) { status.querySelector('.stxt').textContent = 'No data'; return; }
    var when = d.year || (d.publishedAt || '').slice(0, 10);
    status.querySelector('.stxt').textContent = 'Rules v' + d.version + ' · ' + when;
    var lastCheck = 0;
    try { lastCheck = +localStorage.getItem(LS_CHECK) || 0; } catch (e) {}
    var verified = state.source === 'live' ||
      (state.source === 'cache' && Date.now() - lastCheck < CHECK_EVERY_MS);
    status.classList.toggle('live', verified);
    status.title = verified
      ? 'Verified against rules.britishhorseracing.com recently'
      : 'Using ' + (state.source === 'cache' ? 'locally cached' : 'built-in') + ' copy';
  }

  // The home hub: one card per top-level document, each opening straight
  // into that document's browse view (via the existing tab filter).
  function renderDocuments(d) {
    var wrap = document.createElement('div');
    wrap.className = 'docs';

    var ruleCount = d.entries.filter(function (e) { return !isGuideEntry(e); }).length;
    var newCount = d.entries.filter(function (e) { return e.isNew; }).length;
    var rulesMeta = (state.bookOverrides && state.bookOverrides.rules) || {};
    var ruleCard = documentCard({
      icon: 'book',
      title: rulesMeta.title || 'Rules of Racing',
      meta: 'v' + d.version + ' · ' + (d.year || '') + ' · ' + ruleCount + ' entries' +
        (newCount ? ' · ' + newCount + ' new' : ''),
      whatsNew: rulesMeta.whatsNew,
      onClick: function () { enterReader('rules'); }
    });
    wrap.appendChild(ruleCard);

    var guideCard;
    if (state.guidesState === 'ready') {
      var guideCount = d.entries.filter(isGuideEntry).length;
      guideCard = documentCard({
        icon: 'library',
        title: 'Guide Library',
        meta: state.guides.documents + ' documents · ' + guideCount + ' entries',
        onClick: function () { enterReader('guides'); }
      });
    } else {
      guideCard = documentCard({
        icon: 'library',
        title: 'Guide Library',
        meta: state.guidesState === 'failed' ? 'Unavailable right now' : 'Loading…',
        onClick: function () { if (state.guidesState === 'ready') enterReader('guides'); },
        disabled: state.guidesState !== 'ready'
      });
    }
    wrap.appendChild(guideCard);

    var bhagiCard;
    if (state.guidesState === 'ready') {
      var bhagiEntries = d.entries.filter(function (e) { return e.kind === 'bhagi'; });
      var bhagiDocs = {};
      bhagiEntries.forEach(function (e) { bhagiDocs[e.doc] = 1; });
      bhagiCard = documentCard({
        icon: 'bhagi',
        title: 'BHAGIs',
        meta: Object.keys(bhagiDocs).length + ' sections · ' + bhagiEntries.length + ' entries',
        onClick: function () { enterReader('bhagi'); }
      });
    } else {
      bhagiCard = documentCard({
        icon: 'bhagi',
        title: 'BHAGIs',
        meta: state.guidesState === 'failed' ? 'Unavailable right now' : 'Loading…',
        onClick: function () { if (state.guidesState === 'ready') enterReader('bhagi'); },
        disabled: state.guidesState !== 'ready'
      });
    }
    wrap.appendChild(bhagiCard);

    var historyMeta;
    if (state.historyState === 'ready') {
      var oldest = state.history[state.history.length - 1];
      var oldestYear = oldest && /((?:19|20)\d{2})/.exec(oldest.label);
      historyMeta = state.history.length + ' dated snapshots' + (oldestYear ? ' · back to ' + oldestYear[1] : '');
    } else if (state.historyState === 'failed') {
      historyMeta = 'Unavailable right now';
    } else {
      historyMeta = 'Loading…';
    }
    var historyCard = documentCard({
      icon: 'history',
      title: 'Version History',
      meta: historyMeta,
      onClick: function () { if (state.historyState === 'ready') openHistoryPanel(); },
      disabled: state.historyState !== 'ready'
    });
    wrap.appendChild(historyCard);
    return wrap;
  }

  function documentCard(opts) {
    var card = document.createElement('div');
    card.className = 'doc-card' + (opts.disabled ? ' disabled' : '');
    card.innerHTML = '<span class="doc-info"><span class="doc-title">' + P.escapeHtml(opts.title) + '</span>' +
      '<span class="doc-meta">' + P.escapeHtml(opts.meta) + '</span>' +
      (opts.whatsNew ? '<span class="doc-whatsnew">What’s new: ' + P.escapeHtml(opts.whatsNew) + '</span>' : '') +
      '</span>';
    if (!opts.disabled) card.addEventListener('click', opts.onClick);
    return card;
  }

  // ---- reader (Word/Docs-style document view with a navigable outline) --

  function buildPathTree(entries, nextId) {
    var root = { id: null, label: null, badge: null, isNew: false, children: [], entries: [], _map: {} };
    entries.forEach(function (e) {
      var segs = (e.path || []).slice(0, -1);
      var node = root;
      segs.forEach(function (seg) {
        if (!seg) return;
        if (!node._map[seg]) {
          var child = { id: nextId(), label: seg, badge: null, isNew: false, children: [], entries: [], _map: {} };
          node._map[seg] = child;
          node.children.push(child);
        }
        node = node._map[seg];
      });
      node.entries.push(e);
    });
    return root;
  }

  function markTreeNew(node) {
    var any = node.entries.some(function (e) { return e.isNew; });
    var anyUpdated = node.entries.some(function (e) { return e.isUpdated; });
    node.children.forEach(function (c) {
      var r = markTreeNew(c);
      if (r.isNew) any = true;
      if (r.isUpdated) anyUpdated = true;
    });
    node.isNew = any;
    node.isUpdated = anyUpdated;
    return { isNew: any, isUpdated: anyUpdated };
  }

  // Rules of Racing: one top-level outline node per manual (A, B, C…) plus
  // one per code/guide document, each holding its own path-based subtree —
  // exactly the hierarchy the BHA site itself renders per document.
  function buildRulesOutline(manuals, entries) {
    var seq = 0;
    function nextId() { return 'sec' + (seq++); }
    var top = [];
    manuals.forEach(function (m) {
      var manEntries = entries.filter(function (e) { return e.letter === m.letter; });
      if (!manEntries.length) return;
      var node = buildPathTree(manEntries, nextId);
      node.id = nextId();
      node.label = m.title;
      node.badge = m.letter;
      markTreeNew(node);
      top.push(node);
    });
    var codeDocs = {}, order = [];
    entries.forEach(function (e) {
      if (e.kind !== 'code' && e.kind !== 'guide') return;
      if (!codeDocs[e.doc]) { codeDocs[e.doc] = []; order.push(e.doc); }
      codeDocs[e.doc].push(e);
    });
    order.forEach(function (docName) {
      var node = buildPathTree(codeDocs[docName], nextId);
      node.id = nextId();
      node.label = docName;
      markTreeNew(node);
      top.push(node);
    });
    return top;
  }

  // Guide Library: category → document, matching how the PDF export and
  // BHAGI numbering already group these.
  function buildGuidesOutline(entries) {
    var seq = 0;
    function nextId() { return 'gsec' + (seq++); }
    var cats = {}, order = [];
    entries.forEach(function (e) {
      if (!cats[e.cat]) { cats[e.cat] = { id: nextId(), label: e.cat, badge: null, isNew: false, children: [], entries: [], _docs: {} }; order.push(e.cat); }
      var catNode = cats[e.cat];
      if (!catNode._docs[e.doc]) {
        var docNode = { id: nextId(), label: e.doc, badge: null, isNew: false, children: [], entries: [] };
        catNode._docs[e.doc] = docNode;
        catNode.children.push(docNode);
      }
      catNode._docs[e.doc].entries.push(e);
    });
    return order.map(function (c) { markTreeNew(cats[c]); return cats[c]; });
  }

  var NEW_PILL = '<span class="pill-new">new</span>';
  var UPDATED_PILL = '<span class="pill-updated">updated</span>';
  function statusPill(x) { return x.isNew ? NEW_PILL : x.isUpdated ? UPDATED_PILL : ''; }

  // A filter pass over the outline tree that keeps a node whenever it (or
  // any descendant) still has matching entries — same shape as the source
  // tree, so the nav and content renderers don't need to know about search
  // at all. tokens=[] (no in-doc search active) passes every node through.
  function filterOutlineTree(nodes, tokens, newOnly) {
    var noFilter = !tokens.length && !newOnly;
    var out = [];
    nodes.forEach(function (n) {
      var matchedEntries = n.entries.filter(function (e) {
        if (newOnly && !e.isNew) return false;
        return !tokens.length || tokens.every(function (t) { return e.text.indexOf(t) !== -1; });
      });
      var filteredChildren = filterOutlineTree(n.children, tokens, newOnly);
      if (noFilter || matchedEntries.length || filteredChildren.length) {
        out.push({ id: n.id, label: n.label, badge: n.badge, isNew: n.isNew, entries: matchedEntries, children: filteredChildren });
      }
    });
    return out;
  }

  function countOutlineEntries(nodes) {
    var n = 0;
    nodes.forEach(function (node) { n += node.entries.length + countOutlineEntries(node.children); });
    return n;
  }

  function renderOutlineNav(nodes, depth) {
    var wrap = document.createElement('div');
    wrap.className = 'outline-level';
    nodes.forEach(function (n) {
      var row = document.createElement('a');
      row.className = 'outline-link depth-' + depth;
      row.href = '#';
      row.dataset.target = n.id;
      row.innerHTML = (n.badge ? '<span class="cl sm">' + P.escapeHtml(n.badge) + '</span>' : '') +
        statusPill(n) + '<span>' + P.escapeHtml(n.label) + '</span>';
      row.addEventListener('click', function (ev) {
        ev.preventDefault();
        var el = document.getElementById(n.id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      wrap.appendChild(row);
      if (n.children.length) wrap.appendChild(renderOutlineNav(n.children, depth + 1));
    });
    return wrap;
  }

  function renderReaderSection(n, depth, terms) {
    var frag = document.createDocumentFragment();
    var head = document.createElement('div');
    head.id = n.id;
    head.dataset.outlineId = n.id;
    head.dataset.outlineLabel = n.label;
    head.className = 'reader-heading depth-' + depth;
    head.innerHTML = (n.badge ? '<span class="cl">' + P.escapeHtml(n.badge) + '</span>' : '') +
      statusPill(n) + P.escapeHtml(n.label);
    frag.appendChild(head);
    n.entries.forEach(function (e) {
      var block = document.createElement('div');
      block.className = 'reader-entry';
      block.dataset.key = entryKey(e);
      // A numbered rule (e.code) already carries its own number inline as
      // the first thing in its body (the .rn span) — matching BHA's own
      // site, which has no separate heading number either. Repeating it
      // in a badge up here was this app's own redundant addition. Guide/
      // BHAGI/Code entries have no such inline number, so they keep the
      // badge as their only visible identifier.
      block.innerHTML = '<div class="reader-entry-head">' +
        (e.code ? '' : '<span class="' + codeClass(e) + '">' + P.escapeHtml(dispCode(e)) + '</span>') +
        statusPill(e) +
        '<span class="reader-entry-title">' + highlight(P.escapeHtml(e.title), terms) + '</span></div>' +
        '<div class="rfull reader-body">' + highlightHtml(glossarize(groupFlaggedLines(e.html)), terms) + '</div>' +
        (e.penalties ? '<button type="button" class="penalty-link">Penalty</button>' : '');
      if (e.penalties) block.querySelector('.penalty-link').addEventListener('click', function () { showPenaltyModal(e); });
      frag.appendChild(block);
    });
    n.children.forEach(function (c) { frag.appendChild(renderReaderSection(c, depth + 1, terms)); });
    return frag;
  }

  // On desktop the reader gives each column (outline / content / defs) its
  // own scroll instead of the page's, so the scroll-spy has to watch the
  // scrollable pane itself and measure headings relative to IT, not the
  // viewport. On the mobile fallback layout (see the min-width:821px guard
  // in styles.css) that same pane has no overflow of its own — the page
  // scrolls as a whole there instead, so watching window scroll still
  // covers it exactly the same way this always used to work.
  var readerScrollHandler = null, readerScrollTarget = null;
  function teardownScrollSpy() {
    if (readerScrollHandler && readerScrollTarget) readerScrollTarget.removeEventListener('scroll', readerScrollHandler);
    readerScrollHandler = null;
    readerScrollTarget = null;
  }
  function setupScrollSpy(entriesEl) {
    teardownScrollSpy();
    var pane = entriesEl.parentElement; // .reader-content — the scrollable pane on desktop
    var scrollsInternally = pane && pane.scrollHeight > pane.clientHeight + 4;
    var target = scrollsInternally ? pane : window;
    var ticking = false;
    function update() {
      ticking = false;
      var refTop = scrollsInternally ? pane.getBoundingClientRect().top : 0;
      var offset = scrollsInternally ? 10 : 90;
      var headings = Array.prototype.slice.call(entriesEl.querySelectorAll('[data-outline-id]'));
      var activeId = headings.length ? headings[0].dataset.outlineId : null;
      var activeTopHeading = headings.length ? (headings[0].classList.contains('depth-0') ? headings[0] : null) : null;
      for (var i = 0; i < headings.length; i++) {
        if (headings[i].getBoundingClientRect().top - refTop - offset <= 0) {
          activeId = headings[i].dataset.outlineId;
          if (headings[i].classList.contains('depth-0')) activeTopHeading = headings[i];
        } else break;
      }
      Array.prototype.forEach.call(document.querySelectorAll('.outline-link'), function (a) {
        a.classList.toggle('active', a.dataset.target === activeId);
      });
      var crumbSection = $('breadcrumbSection');
      if (crumbSection) crumbSection.textContent = activeTopHeading ? activeTopHeading.dataset.outlineLabel : '';
    }
    readerScrollHandler = function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };
    readerScrollTarget = target;
    target.addEventListener('scroll', readerScrollHandler, { passive: true });
    update();
  }

  // Heights vary with content (the beta banner wraps to 1 or 2 lines) and
  // viewport width, so they're measured rather than hardcoded, and re-synced
  // on resize. Below the 821px breakpoint styles.css doesn't use these at
  // all — the reader falls back to normal whole-page scrolling there.
  function syncReaderChromeOffsets() {
    var betaEl = $('beta'), headerEl = document.querySelector('header'), backEl = document.querySelector('.reader-back');
    var betaH = betaEl ? betaEl.offsetHeight : 0;
    var headerH = headerEl ? headerEl.offsetHeight : 0;
    var backH = backEl ? backEl.offsetHeight : 0;
    var root = document.documentElement.style;
    root.setProperty('--rd-beta-h', betaH + 'px');
    root.setProperty('--rd-topbar-h', (betaH + headerH) + 'px');
    root.setProperty('--rd-backrow-h', backH + 'px');
  }
  window.addEventListener('resize', function () {
    if (state.mode === 'reader') syncReaderChromeOffsets();
  });

  // Belt-and-braces against the outer page moving at all in desktop reader
  // mode: html/body get overflow:hidden there specifically so only "the
  // nav" and "the doc" (the independently-scrolling panes) ever move — but
  // that only blocks user-driven wheel/touch scrolling. A programmatic
  // el.scrollIntoView() call (outline links, "Find in document", the
  // Penalty modal's "Visit section") can still cascade up and nudge
  // document.documentElement.scrollTop directly, which shifts the fixed
  // Back/breadcrumb row and the top of the row up behind the fixed header
  // — looking like they vanished. Snapping straight back to 0 neutralises
  // that regardless of what caused it, present or future.
  var desktopReaderMQ = window.matchMedia('(min-width: 821px)');
  window.addEventListener('scroll', function () {
    if (state.mode === 'reader' && desktopReaderMQ.matches && window.scrollY !== 0) window.scrollTo(0, 0);
  }, { passive: true });

  function enterReader(book) {
    q.value = '';
    $('clear').classList.remove('show');
    state.mode = 'reader';
    state.readerBook = book;
    state.tab = book;
    renderTabs();
    renderIdle();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function exitReader() {
    if (state.mode !== 'reader') return;
    state.mode = 'search';
    state.activeDefTerm = null;
    document.body.classList.remove('reader-mode');
    teardownScrollSpy();
  }

  // Re-renders just the outline list and the entries container from the
  // full (unfiltered) tree cached on state.readerTree — used for the first
  // paint and every keystroke in the in-doc search box. The search input
  // and count live in a wrapper outside both of these and are never
  // touched, so the input never loses focus while the user is typing.
  function renderReaderBody(navListEl, entriesEl, countEl, titleText, rawQuery) {
    var tokens = rawQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var newOnly = !!state.readerNewOnly;
    var filtering = tokens.length || newOnly;
    var filtered = filterOutlineTree(state.readerTree, tokens, newOnly);

    navListEl.innerHTML = '';
    navListEl.appendChild(renderOutlineNav(filtered, 0));

    entriesEl.innerHTML = '';
    if (filtering) {
      var n = countOutlineEntries(filtered);
      countEl.textContent = n + (n === 1 ? ' match' : ' matches') + ' in ' + titleText;
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
    if (filtering && !filtered.length) {
      var none = document.createElement('div');
      none.className = 'noresults';
      none.textContent = newOnly && !tokens.length ? 'Nothing flagged new right now.' : 'Nothing in ' + titleText + ' matches that — try a different word.';
      entriesEl.appendChild(none);
    } else {
      filtered.forEach(function (n) { entriesEl.appendChild(renderReaderSection(n, 0, tokens)); });
    }

    teardownScrollSpy();
    if (!filtering) setupScrollSpy(entriesEl);
  }

  function renderReaderView() {
    var d = state.data;
    var book = state.readerBook;
    var titleText = book === 'guides' ? 'Guide Library' : book === 'bhagi' ? 'BHAGIs' : 'Rules of Racing';
    meta.textContent = '';

    state.readerTree = book === 'guides'
      ? buildGuidesOutline(d.entries.filter(isGuideEntry))
      : book === 'bhagi'
      ? buildGuidesOutline(d.entries.filter(function (e) { return e.kind === 'bhagi'; }))
      : buildRulesOutline(d.manuals, d.entries.filter(function (e) { return !isGuideEntry(e); }));

    var wrap = document.createElement('div');
    wrap.className = 'reader';

    var back = document.createElement('nav');
    back.className = 'reader-back';
    back.setAttribute('aria-label', 'Breadcrumb');
    back.innerHTML =
      '<button type="button" class="crumb-home" title="Home">' +
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5L8 2.5l5.5 5"></path><path d="M4 6.5V13h8V6.5"></path></svg>' +
      'Home</button>' +
      '<span class="crumb-sep">/</span>' +
      '<button type="button" class="crumb-book">' + P.escapeHtml(titleText) + '</button>' +
      '<span class="crumb-sep">/</span>' +
      '<span class="crumb-section" id="breadcrumbSection"></span>' +
      '<button type="button" class="reader-back-search" aria-label="Search">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"></circle><path d="M11 11l3.5 3.5"></path></svg></button>';
    back.querySelector('.crumb-home').addEventListener('click', goHome);
    back.querySelector('.crumb-book').addEventListener('click', function () { scroll.scrollTo({ top: 0, behavior: 'smooth' }); });
    // Below 820px (see styles.css) there's no room for the persistent
    // outline pane and its own "search within" box, so this icon is the
    // mobile entry point instead — it opens the same global search used
    // everywhere else in the app, Wikipedia-style simplicity over a
    // dedicated in-doc nav.
    back.querySelector('.reader-back-search').addEventListener('click', openSearchModal);

    var nav = document.createElement('nav');
    nav.className = 'outline';

    state.readerNewOnly = false;

    var searchWrap = document.createElement('div');
    searchWrap.className = 'reader-search-wrap';
    searchWrap.innerHTML = '<input type="search" class="reader-search" placeholder="Search within ' +
      P.escapeHtml(titleText) + '…" aria-label="Search within ' + P.escapeHtml(titleText) + '">' +
      '<label class="reader-new-toggle"><input type="checkbox" class="reader-new-only"> Show new only</label>' +
      '<div class="reader-search-count" hidden></div>';
    nav.appendChild(searchWrap);
    var countEl = searchWrap.querySelector('.reader-search-count');
    var newOnlyInput = searchWrap.querySelector('.reader-new-only');

    var navList = document.createElement('div');
    navList.className = 'outline-list';
    nav.appendChild(navList);

    var content = document.createElement('div');
    content.className = 'reader-content';

    var scroll = document.createElement('div');
    scroll.className = 'reader-scroll';
    content.appendChild(scroll);

    var title = document.createElement('div');
    title.className = 'reader-title';
    title.textContent = titleText;
    scroll.appendChild(title);

    var entriesEl = document.createElement('div');
    entriesEl.className = 'reader-entries';
    scroll.appendChild(entriesEl);

    var toTop = document.createElement('button');
    toTop.type = 'button';
    toTop.className = 'back-to-top';
    toTop.title = 'Back to top';
    toTop.setAttribute('aria-label', 'Back to top');
    toTop.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V3.5"></path><path d="M4 7.5L8 3.5l4 4"></path></svg>';
    toTop.addEventListener('click', function () { scroll.scrollTo({ top: 0, behavior: 'smooth' }); });
    content.appendChild(toTop);
    scroll.addEventListener('scroll', function () {
      toTop.classList.toggle('show', scroll.scrollTop > 300);
    }, { passive: true });

    var searchInput = searchWrap.querySelector('.reader-search');
    var debounce = null;
    searchInput.addEventListener('input', function () {
      clearTimeout(debounce);
      var val = searchInput.value;
      debounce = setTimeout(function () { renderReaderBody(navList, entriesEl, countEl, titleText, val); }, 80);
    });
    newOnlyInput.addEventListener('change', function () {
      state.readerNewOnly = newOnlyInput.checked;
      renderReaderBody(navList, entriesEl, countEl, titleText, searchInput.value);
    });

    var row = document.createElement('div');
    row.className = 'reader-row';
    row.appendChild(nav);
    row.appendChild(content);

    if (state.glossaryState === 'ready') {
      state.activeDefTerm = null;
      var defPanel = document.createElement('div');
      defPanel.className = 'def-panel';
      defPanel.id = 'defPanel';
      row.appendChild(defPanel);
    }

    wrap.appendChild(back);
    wrap.appendChild(row);
    results.appendChild(wrap);

    document.body.classList.add('reader-mode');
    syncReaderChromeOffsets();
    renderReaderBody(navList, entriesEl, countEl, titleText, '');
    if (state.glossaryState === 'ready') renderDefPanel();
  }

  function renderDefPanel() {
    var panel = $(state.mode === 'reader' ? 'defPanel' : 'flatDefPanel');
    if (!panel) return;
    if (state.activeDefTerm == null) {
      // Empty rather than a hint placeholder — the panel (see #defPanel:empty
      // / #flatDefPanel:empty in styles.css) collapses entirely until the
      // reader actually clicks a term, instead of reserving a column with
      // "click a term" filler text sitting there by default.
      panel.innerHTML = '';
      return;
    }
    var t = state.glossary.terms.filter(function (x) { return x.id === state.activeDefTerm; })[0];
    if (!t) return;
    panel.innerHTML = '<div class="def-panel-head"><div class="def-panel-term">' + P.escapeHtml(t.term) + '</div>' +
      '<button type="button" class="def-panel-close" aria-label="Close definition">✕</button></div>' +
      '<div class="rfull">' + t.html + '</div>';
    panel.querySelector('.def-panel-close').addEventListener('click', function () {
      state.activeDefTerm = null;
      renderDefPanel();
    });
    // The panel keeps its own scroll position across re-renders (replacing
    // innerHTML doesn't reset it) — without this, picking a short definition
    // right after scrolling through a long one can leave it start out of
    // view, looking like the panel "lost" the new term until scrolled back up.
    panel.scrollTop = 0;
  }

  var defPopover = null;
  function closeDefPopover() {
    if (defPopover) { defPopover.remove(); defPopover = null; }
    document.removeEventListener('click', outsideDefPopoverClick, true);
  }
  function outsideDefPopoverClick(ev) {
    if (defPopover && !defPopover.contains(ev.target) && !(ev.target.closest && ev.target.closest('.defterm'))) closeDefPopover();
  }
  function showDefPopover(t, anchorEl) {
    closeDefPopover();
    var pop = document.createElement('div');
    pop.className = 'def-popover';
    pop.innerHTML = '<div class="def-popover-head">' + P.escapeHtml(t.term) +
      '<button type="button" class="def-popover-close" aria-label="Close">✕</button></div>' +
      '<div class="rfull">' + t.html + '</div>';
    document.body.appendChild(pop);
    var rect = anchorEl.getBoundingClientRect();
    var top = rect.bottom + window.scrollY + 6;
    var left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - pop.offsetWidth - 16));
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    pop.querySelector('.def-popover-close').addEventListener('click', closeDefPopover);
    defPopover = pop;
    setTimeout(function () { document.addEventListener('click', outsideDefPopoverClick, true); }, 0);
  }

  // Defined terms are clickable everywhere they're glossarized (reader
  // entries and expanded search cards) — a single delegated listener
  // covers both, since the spans are created in many different places.
  // Both the reader and flat list/card views show the definition in a
  // persistent side panel matching the breakpoint where that panel has
  // room to sit beside the content (see #flatDefPanel in styles.css);
  // narrower viewports fall back to a floating popover instead.
  var flatDefPanelMQ = window.matchMedia('(min-width: 900px)');
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest && ev.target.closest('.defterm');
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    var t = state.glossary && state.glossary.terms.filter(function (x) { return String(x.id) === el.dataset.termId; })[0];
    if (!t) return;
    if (state.mode === 'reader' && $('defPanel')) {
      state.activeDefTerm = t.id;
      renderDefPanel();
    } else if (state.mode !== 'reader' && $('flatDefPanel') && flatDefPanelMQ.matches) {
      state.activeDefTerm = t.id;
      renderDefPanel();
    } else {
      showDefPopover(t, el);
    }
  });

  // ---- version history panel --------------------------------------------

  function parseHistory(historyField) {
    var comps = (historyField && historyField.components) || [];
    var out = [];
    comps.forEach(function (c) {
      if (!c || c.type !== 'textblock') return;
      var html = c.html || '';
      var m = /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/i.exec(html);
      if (m) {
        var label = P.toText(m[2]);
        if (label) out.push({ label: label, url: m[1] });
      } else {
        var text = P.toText(html);
        if (text) out.push({ label: text, url: null });
      }
    });
    return out;
  }

  function loadHistory() {
    if (!state.data || !state.data.bookId) return;
    if (state.historyState === 'loading' || state.historyState === 'ready') return;
    state.historyState = 'loading';

    var cached = null;
    try {
      var raw = localStorage.getItem(LS_HISTORY);
      if (raw) cached = JSON.parse(raw);
    } catch (e) { /* ignore */ }
    if (cached && cached.bookId === state.data.bookId && cached.items && cached.items.length) {
      state.history = cached.items;
      state.historyState = 'ready';
      refreshView();
    }

    getJSON('/api/books/' + state.data.bookId + '?with=history', 15000).then(function (full) {
      var items = parseHistory(full.history);
      if (!items.length) throw new Error('empty history');
      state.history = items;
      state.historyState = 'ready';
      refreshView();
      try { localStorage.setItem(LS_HISTORY, JSON.stringify({ bookId: state.data.bookId, items: items })); } catch (e) { /* quota */ }
    }).catch(function () {
      if (state.historyState !== 'ready') state.historyState = 'failed';
      refreshView();
    });
  }

  var historyPanel = $('historyPanel');
  function renderHistoryList() {
    var list = $('historyList');
    if (!state.history || !state.history.length) { list.innerHTML = '<div class="hint">No version history loaded.</div>'; return; }
    list.innerHTML = state.history.map(function (h) {
      return '<div class="history-row"><span class="history-label">' + P.escapeHtml(h.label) + '</span>' +
        (h.url
          ? '<a class="history-link" href="' + API_HOST + h.url + '" target="_blank" rel="noopener">Download PDF ↗</a>'
          : '<span class="history-missing">No archived copy</span>') +
        '</div>';
    }).join('');
  }
  function openHistoryPanel() {
    renderHistoryList();
    if (typeof historyPanel.showModal === 'function') historyPanel.showModal();
    else historyPanel.setAttribute('open', '');
  }
  $('historyPanelClose').addEventListener('click', function () {
    historyPanel.close ? historyPanel.close() : historyPanel.removeAttribute('open');
  });

  // ---- changelog tab (Linear-"Now"-style dated feed) ---------------------
  //
  // The only version we can genuinely describe is the current one — the
  // BHA's own `highlighted: 'new'` flags tell us exactly what changed and
  // where. Older entries only ever gave us a dated PDF (from the history
  // panel above), so those render as plain archive rows rather than
  // invented change notes.
  function renderChangelog() {
    var d = state.data;

    if (state.historyState !== 'ready') {
      meta.textContent = 'Version history';
      var msg = document.createElement('div');
      msg.className = 'hint';
      msg.textContent = state.historyState === 'failed'
        ? 'Version history is unavailable right now.'
        : 'Loading version history…';
      results.appendChild(msg);
      return;
    }

    var newEntries = d.entries.filter(function (e) { return e.isNew; });
    var groups = {}, order = [];
    newEntries.forEach(function (e) {
      var label = e.letter ? (e.letter + ' — ' + e.doc) : e.doc;
      if (!groups[label]) { groups[label] = 0; order.push(label); }
      groups[label]++;
    });

    var wrap = document.createElement('div');
    wrap.className = 'changelog';

    state.history.forEach(function (h, i) {
      var row = document.createElement('div');
      row.className = 'changelog-row';

      var date = document.createElement('div');
      date.className = 'changelog-date';
      date.innerHTML = '<span class="changelog-dot' + (i === 0 ? ' current' : '') + '"></span>' + P.escapeHtml(h.label);
      row.appendChild(date);

      var body = document.createElement('div');
      body.className = 'changelog-body';
      var head = document.createElement('h3');

      if (i === 0 && order.length) {
        head.textContent = 'Current published version';
        body.appendChild(head);
        var p = document.createElement('p');
        p.textContent = 'The BHA has flagged ' + newEntries.length + ' new or changed rule' +
          (newEntries.length === 1 ? '' : 's') + ' in this version, across:';
        body.appendChild(p);
        var tags = document.createElement('div');
        tags.className = 'changelog-tags';
        order.forEach(function (label) {
          var tag = document.createElement('button');
          tag.className = 'changelog-tag';
          tag.textContent = label + ' (' + groups[label] + ')';
          tag.addEventListener('click', function () { selectTab('new'); });
          tags.appendChild(tag);
        });
        body.appendChild(tags);
      } else {
        head.textContent = i === 0 ? 'Current published version' : 'Archived version';
        body.appendChild(head);
      }

      if (h.url) {
        var a = document.createElement('a');
        a.className = 'changelog-link';
        a.href = API_HOST + h.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Download PDF ↗';
        body.appendChild(a);
      } else {
        var span = document.createElement('span');
        span.className = 'history-missing';
        span.textContent = 'No archived copy for this period';
        body.appendChild(span);
      }

      row.appendChild(body);
      wrap.appendChild(row);
    });

    results.appendChild(wrap);
    meta.textContent = state.history.length + ' dated versions';
  }

  function renderIdle() {
    var d = state.data;
    results.innerHTML = '';
    if (!d) { meta.textContent = 'Loading…'; return; }

    if (state.mode === 'reader') { renderReaderView(); return; }
    document.body.classList.remove('reader-mode');
    // renderResults() (below, for the "new" tab) repopulates this — clearing
    // it here first means non-card views (home cards, changelog) don't show
    // a stale or irrelevant "click a term" hint next to content with no
    // defined terms in it.
    var flatPanel = $('flatDefPanel');
    if (flatPanel) flatPanel.innerHTML = '';

    var tab = state.tab;

    if (tab === 'new') {
      var newEntries = d.entries.filter(function (e) { return e.isNew; });
      state.lastTerms = [];
      if (!newEntries.length) {
        meta.textContent = 'No changes flagged in the current version';
        var none = document.createElement('div');
        none.className = 'noresults';
        none.textContent = 'The BHA hasn\'t flagged anything as new or changed in this published version.';
        results.appendChild(none);
        return;
      }
      renderResults({ entries: newEntries, terms: [], mode: 'browse', exact: false });
      meta.textContent = newEntries.length + (newEntries.length === 1 ? ' new entry' : ' new entries') + ' in the current version';
      return;
    }

    if (tab === 'changelog') { renderChangelog(); return; }

    var counted = d.entries.filter(function (e) { return inTab(e, tab, state.sub); }).length;
    meta.textContent = counted + ' searchable ' +
      (tab === 'guides' ? 'guide sections' : tab === 'rules' ? 'rules and sections' : 'entries') +
      ' loaded' +
      (tab !== 'rules' && state.guidesState === 'loading' ? ' — guides loading…' : '');

    var home = document.createElement('div');
    home.className = 'home';

    if (tab === 'all' && !q.value.trim()) {
      home.appendChild(renderDocuments(d));
    }

    results.appendChild(home);
  }

  // Tab counts come from the current (unfiltered) result set, so switching
  // tabs never re-runs the search.
  function renderTabs(res) {
    var subtabs = $('subtabs');
    var counts = null;
    if (res) {
      counts = { all: res.entries.length, rules: 0, guides: 0, bhagi: 0, new: 0 };
      res.entries.forEach(function (e) {
        if (isGuideEntry(e)) {
          counts.guides++;
          if (e.kind === 'bhagi') counts.bhagi++;
        } else counts.rules++;
        if (e.isNew) counts.new++;
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button.tab'), function (t) {
      var key = t.dataset.tab;
      var on = state.tab === key && state.mode !== 'reader';
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      var label = key === 'all' ? 'All' : key === 'new' ? 'New' : 'Changelog';
      var n = counts ? counts[key] : null;
      t.innerHTML = label + (n != null ? '<span class="n">' + n + '</span>' : '');
    });
    subtabs.hidden = state.tab !== 'guides' || state.mode === 'reader';
    Array.prototype.forEach.call(document.querySelectorAll('#subtabs .subtab'), function (t) {
      var on = state.sub === t.dataset.sub;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      var label = t.dataset.sub === 'bhagi' ? 'BHAGIs' : 'All guides';
      var n = counts ? counts[t.dataset.sub === 'bhagi' ? 'bhagi' : 'guides'] : null;
      t.innerHTML = label + (n != null ? ' <span class="n">' + n + '</span>' : '');
    });
  }

  function selectTab(tab) {
    var wasReader = state.mode === 'reader';
    if (state.tab === tab && !wasReader) return;
    exitReader();
    state.tab = tab;
    state.shown = PAGE;
    runSearch();
  }

  Array.prototype.forEach.call(document.querySelectorAll('#tabs button.tab'), function (t) {
    t.addEventListener('click', function () { if (!t.disabled) selectTab(t.dataset.tab); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#subtabs .subtab'), function (t) {
    t.addEventListener('click', function () {
      if (state.sub === t.dataset.sub) return;
      state.sub = t.dataset.sub;
      state.shown = PAGE;
      runSearch();
    });
  });

  function renderResults(res) {
    results.innerHTML = '';
    state.activeIdx = -1;
    if (state.glossaryState === 'ready') renderDefPanel();
    if (!res.entries.length) {
      meta.textContent = 'No matches';
      var n = document.createElement('div');
      n.className = 'noresults';
      n.textContent = 'Nothing found for that — try a rule code like F45, or fewer / broader keywords.';
      results.appendChild(n);
      return;
    }
    meta.textContent = res.entries.length + (res.entries.length === 1 ? ' match' : ' matches');
    var frag = document.createDocumentFragment();
    var visible = res.entries.slice(0, state.shown);
    visible.forEach(function (e, i) {
      frag.appendChild(card(e, res.terms, i));
    });
    results.appendChild(frag);
    if (res.entries.length > state.shown) {
      var more = document.createElement('button');
      more.className = 'more';
      more.textContent = 'Show all ' + res.entries.length + ' matches';
      more.addEventListener('click', function () {
        state.shown = res.entries.length;
        renderResults(res);
      });
      results.appendChild(more);
    }
    // auto-expand the rule when the query was an exact code
    if (res.exact && visible.length) {
      toggleCard(results.querySelector('.result'), true);
    }
  }

  function card(e, terms, idx) {
    var div = document.createElement('div');
    div.className = 'result';
    div.dataset.idx = idx;
    div.dataset.id = e.id;

    var head = document.createElement('button');
    head.className = 'rhead';
    head.setAttribute('aria-expanded', 'false');
    var codeHtml = '<span class="' + codeClass(e) + '">' + P.escapeHtml(dispCode(e)) + '</span>';
    var crumbBits = isGuideEntry(e)
      ? [e.cat, e.doc]
      : [e.letter ? e.letter + ' — ' + e.doc : e.doc].concat((e.path || []).slice(0, -1));
    var crumbHtml = '<span class="crumb">' + HOME_ICON +
      crumbBits.map(function (b) { return '<span class="crumb-sep">›</span><span class="crumb-part">' + P.escapeHtml(b) + '</span>'; }).join('') +
      (isGuideEntry(e) && e.dated ? '<span class="crumb-dated">dated ' + P.escapeHtml(e.dated) + '</span>' : '') +
      '</span>';
    head.innerHTML = crumbHtml +
      '<span class="rmain">' + codeHtml +
      '<span class="rtitle">' + highlight(P.escapeHtml(e.title), terms) + '</span></span>';
    div.appendChild(head);

    var ex = document.createElement('div');
    ex.className = 'rex';
    ex.innerHTML = highlight(P.escapeHtml(excerpt(e, terms)), terms);
    div.appendChild(ex);

    var toggle = function () { toggleCard(div); };
    head.addEventListener('click', toggle);
    ex.addEventListener('click', toggle);
    return div;
  }

  function toggleCard(div, forceOpen) {
    if (!div || !div.classList || !div.classList.contains('result')) return;
    var full = div.querySelector('.rfull');
    var head = div.querySelector('.rhead');
    var ex = div.querySelector('.rex');
    if (full && !forceOpen) {
      full.remove();
      if (ex) ex.style.display = '';
      head.setAttribute('aria-expanded', 'false');
      return;
    }
    if (full) return;
    var e = state.data.entries[+div.dataset.id];
    full = document.createElement('div');
    full.className = 'rfull';
    full.innerHTML = highlightHtml(glossarize(groupFlaggedLines(e.html)), state.lastTerms);
    if (isGuideEntry(e) && e.url) {
      var a = document.createElement('a');
      a.className = 'srclink';
      a.href = e.url + (e.page > 1 ? '#page=' + e.page : '');
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open source PDF' + (e.page > 1 ? ' (p.' + e.page + ')' : '') + ' ↗';
      a.addEventListener('click', function (ev) { ev.stopPropagation(); });
      full.appendChild(a);
    }
    div.appendChild(full);
    if (ex) ex.style.display = 'none';
    head.setAttribute('aria-expanded', 'true');
  }

  // ---------------------------------------------------------- interaction

  var debounceTimer = null;
  function runSearch() {
    var raw = q.value;
    $('clear').classList.toggle('show', !!raw.trim());
    if (!raw.trim()) {
      state.lastResults = []; state.lastTerms = [];
      renderTabs();
      renderIdle();
      return;
    }
    exitReader();
    var res = search(raw);          // searched across everything
    renderTabs(res);                // counts reflect the full result set
    var shown = {
      entries: res.entries.filter(function (e) { return inTab(e, state.tab, state.sub); }),
      terms: res.terms,
      mode: res.mode,
      exact: res.exact && state.tab !== 'rules'
    };
    state.lastResults = shown.entries;
    state.lastTerms = res.terms;
    renderResults(shown);
  }

  q.addEventListener('input', function () {
    state.shown = PAGE;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 70);
  });

  $('clear').addEventListener('click', function () {
    q.value = '';
    runSearch();
  });

  // ------------------------------------------------------ search modal
  //
  // #q is a readonly trigger — the real typing happens in the modal's own
  // input, Notion-search-style: live results on the left, full preview on
  // the right, keyboard-navigable. Picking a result (click or Enter)
  // applies the query to the main app and scrolls/expands that entry.

  var searchModal = $('searchModal'), smInput = $('smInput'), smList = $('smList'), smPreview = $('smPreview');
  var smResults = [], smTerms = [], smActive = -1, smDebounce = null;

  function smRow(e, terms, idx) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'sm-row' + (idx === 0 ? ' active' : '');
    var crumb = isGuideEntry(e) ? (e.cat || e.doc) : (e.letter ? e.letter + ' — ' + e.doc : e.doc);
    row.innerHTML = '<span class="' + codeClass(e) + ' sm-row-code">' + P.escapeHtml(dispCode(e)) + '</span>' +
      statusPill(e) +
      '<span class="sm-row-title">' + highlight(P.escapeHtml(e.title), terms) + '</span>' +
      '<div class="sm-row-path">' + P.escapeHtml(crumb || '') + '</div>';
    row.addEventListener('click', function () { setSmActive(idx); });
    return row;
  }

  function renderSmPreview(e, terms) {
    if (!e) { smPreview.innerHTML = ''; return; }
    var crumb = isGuideEntry(e)
      ? [e.cat, e.doc]
      : [e.letter ? e.letter + ' — ' + e.doc : e.doc].concat((e.path || []).slice(0, -1));
    smPreview.innerHTML = '<div class="sm-preview-path">' + crumb.filter(Boolean).map(P.escapeHtml).join(' › ') + '</div>' +
      '<div class="sm-preview-title"><span class="' + codeClass(e) + '">' + P.escapeHtml(dispCode(e)) + '</span>' +
      statusPill(e) +
      '<span>' + highlight(P.escapeHtml(e.title), terms) + '</span></div>' +
      '<button type="button" class="sm-preview-open">' +
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h6.5A1.5 1.5 0 0 1 11 4v9.5H4.5A1.5 1.5 0 0 1 3 12V2.5z"></path><path d="M3 11.5A1.5 1.5 0 0 1 4.5 10H11"></path></svg>' +
      'Find in document</button>' +
      '<div class="rfull">' + highlightHtml(e.html, terms) + '</div>';
    smPreview.querySelector('.sm-preview-open').addEventListener('click', function () { openInReader(e); });
  }

  function setSmActive(idx) {
    smActive = idx;
    Array.prototype.forEach.call(smList.querySelectorAll('.sm-row'), function (r, i) {
      r.classList.toggle('active', i === idx);
    });
    renderSmPreview(smResults[idx], smTerms);
  }

  function smMatchesScope(e, scope) {
    if (scope === 'rules') return !isGuideEntry(e);
    if (scope === 'guides') return isGuideEntry(e);
    if (scope === 'bhagi') return e.kind === 'bhagi';
    if (scope === 'new') return !!e.isNew;
    return true;
  }

  function renderSmResults(raw) {
    var qs = raw.trim();
    smList.innerHTML = '';
    if (!qs) {
      smResults = []; smTerms = []; smActive = -1;
      smList.innerHTML = '<div class="sm-empty">Type to search the current version of the Rules of Racing and guide library.</div>';
      smPreview.innerHTML = '';
      return;
    }
    var res = search(raw);
    var scope = $('smScope').value;
    smResults = res.entries.filter(function (e) { return smMatchesScope(e, scope); }).slice(0, 40);
    smTerms = res.terms;
    if (!smResults.length) {
      smActive = -1;
      smList.innerHTML = '<div class="sm-empty">Nothing found for that — try a rule code like F45, or fewer / broader keywords.</div>';
      smPreview.innerHTML = '';
      return;
    }
    var frag = document.createDocumentFragment();
    smResults.forEach(function (e, i) { frag.appendChild(smRow(e, smTerms, i)); });
    smList.appendChild(frag);
    smActive = 0;
    renderSmPreview(smResults[0], smTerms);
  }

  function scrollSmActiveIntoView() {
    var el = smList.querySelector('.sm-row.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function openSmResult(idx) {
    var e = smResults[idx];
    if (!e) return;
    closeSearchModal();
    q.value = smInput.value;
    state.tab = 'all';
    state.shown = PAGE;
    runSearch();
    setTimeout(function () {
      var card = results.querySelector('.result[data-id="' + e.id + '"]');
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); toggleCard(card, true); }
    }, 30);
  }

  // Penalty quick-look: BHA's own "Table Of Penalties" appendix, cross-
  // referenced to this rule at build time (see build.js extractPenalties) —
  // real published rows, not anything computed or guessed client-side.
  var penaltyPanel = $('penaltyPanel'), penaltyVisitKey = null;
  function showPenaltyModal(e) {
    $('penaltyTitle').textContent = dispCode(e) + ' — Penalty';
    var rows = e.penalties.rows.map(function (r) {
      return '<tr><td>' + P.escapeHtml(r.rule) + '</td><td>' + P.escapeHtml(r.summary) + '</td><td>' + P.escapeHtml(r.entryPoint) + '</td>' +
        '<td>' + P.escapeHtml(r.range) + '</td><td>' + P.escapeHtml(r.rc) + '</td></tr>';
    }).join('');
    $('penaltyTable').innerHTML = '<div class="penalty-table-wrap"><table class="penalty-table"><thead><tr>' +
      '<th>Rule</th><th>Summary</th><th>Entry Point</th><th>Range</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
    penaltyVisitKey = e.penalties.sectionKey;
    if (typeof penaltyPanel.showModal === 'function') penaltyPanel.showModal();
    else penaltyPanel.setAttribute('open', '');
  }
  function closePenaltyModal() {
    penaltyPanel.close ? penaltyPanel.close() : penaltyPanel.removeAttribute('open');
  }
  if ($('penaltyPanelClose')) $('penaltyPanelClose').addEventListener('click', closePenaltyModal);
  if ($('penaltyVisitBtn')) $('penaltyVisitBtn').addEventListener('click', function () {
    var target = state.data && state.data.entries.filter(function (e) { return entryKey(e) === penaltyVisitKey; })[0];
    closePenaltyModal();
    if (target) openInReader(target);
  });

  function openInReader(e) {
    closeSearchModal();
    var book = e.kind === 'bhagi' ? 'bhagi' : isGuideEntry(e) ? 'guides' : 'rules';
    var key = entryKey(e);
    enterReader(book);
    setTimeout(function () {
      var block = Array.prototype.filter.call(
        document.querySelectorAll('.reader-entry'),
        function (el) { return el.dataset.key === key; }
      )[0];
      if (!block) return;
      block.scrollIntoView({ behavior: 'smooth', block: 'center' });
      block.classList.add('flash');
      setTimeout(function () { block.classList.remove('flash'); }, 1600);
    }, 30);
  }

  function openSearchModal() {
    smInput.value = q.value;
    renderSmResults(smInput.value);
    if (typeof searchModal.showModal === 'function') searchModal.showModal();
    else searchModal.setAttribute('open', '');
    setTimeout(function () { smInput.focus(); smInput.select(); }, 0);
  }

  function closeSearchModal() {
    searchModal.close ? searchModal.close() : searchModal.removeAttribute('open');
  }

  // click-only (not a bare `focus` listener): a readonly input can still
  // receive focus from browser tab-restore / automated tooling with no
  // real user interaction, which must never pop this modal on its own.
  q.addEventListener('click', openSearchModal);
  q.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openSearchModal(); }
  });
  $('smClose').addEventListener('click', closeSearchModal);
  $('smScope').addEventListener('change', function () { renderSmResults(smInput.value); });

  smInput.addEventListener('input', function () {
    clearTimeout(smDebounce);
    smDebounce = setTimeout(function () { renderSmResults(smInput.value); }, 60);
  });
  smInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (smResults.length) { setSmActive(Math.min(smActive + 1, smResults.length - 1)); scrollSmActiveIntoView(); }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (smResults.length) { setSmActive(Math.max(smActive - 1, 0)); scrollSmActiveIntoView(); }
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (smActive >= 0) openSmResult(smActive);
    }
  });

  function goHome() {
    q.value = '';
    state.tab = 'all';
    state.sub = 'all';
    exitReader();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    runSearch();
    renderTabs();
  }
  $('homeBtn').addEventListener('click', goHome);
  $('homeBtn').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goHome(); }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if (q.value) { q.value = ''; runSearch(); }
      q.focus();
      return;
    }
    var cards = results.querySelectorAll('.result');
    if (!cards.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      var dir = ev.key === 'ArrowDown' ? 1 : -1;
      state.activeIdx = Math.max(0, Math.min(cards.length - 1, state.activeIdx + dir));
      cards.forEach(function (c) { c.classList.remove('active'); });
      var c = cards[state.activeIdx];
      c.classList.add('active');
      c.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter' && document.activeElement === q) {
      var target = state.activeIdx >= 0 ? cards[state.activeIdx] : cards[0];
      toggleCard(target);
    }
  });

  // ------------------------------------------------------------ refresh

  var proxyFetchers = [
    function (u) { return fetch(u, { mode: 'cors' }); },
    function (u) { return fetch('https://corsproxy.io/?url=' + encodeURIComponent(u)); },
    function (u) { return fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(u)); },
    function (u) { return fetch('https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)); }
  ];
  var goodFetcher = -1;

  function getJSON(path, timeoutMs) {
    var url = API_HOST + path;
    var order = goodFetcher >= 0
      ? [goodFetcher].concat(proxyFetchers.map(function (_, i) { return i; }).filter(function (i) { return i !== goodFetcher; }))
      : proxyFetchers.map(function (_, i) { return i; });
    var attempt = function (k) {
      if (k >= order.length) return Promise.reject(new Error('all fetch routes failed'));
      var i = order[k];
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl && setTimeout(function () { ctrl.abort(); }, timeoutMs || 25000);
      return proxyFetchers[i](url, ctrl && { signal: ctrl.signal })
        .then(function (r) {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.text();
        })
        .then(function (t) {
          var j = JSON.parse(t); // throws on proxy error pages
          goodFetcher = i;
          return j;
        })
        .catch(function () { return attempt(k + 1); })
        .finally(function () { if (timer) clearTimeout(timer); });
    };
    return attempt(0);
  }

  function pickBook(books) {
    var live = (books || []).filter(function (b) {
      return b && b.published && !b.archived && (b.library_id || 0) > 0;
    }).sort(function (a, b) {
      return String(b.published_at || '').localeCompare(String(a.published_at || ''));
    });
    return live[0] || null;
  }

  function refresh(force) {
    var last = 0;
    try { last = +localStorage.getItem(LS_CHECK) || 0; } catch (e) {}
    if (!force && state.data && Date.now() - last < CHECK_EVERY_MS) return Promise.resolve(false);
    return getJSON('/api/books/', 20000).then(function (books) {
      try { localStorage.setItem(LS_CHECK, String(Date.now())); } catch (e) {}
      var book = pickBook(books);
      if (!book) throw new Error('no published book found');
      if (state.data && state.data.sourceUpdatedAt === book.updated_at) {
        state.source = 'live'; // confirmed current
        saveCache(state.data); // remember the verification across reloads
        renderStatus();
        return false;
      }
      return getJSON('/api/books/' + book.id + '?with=sections', 90000).then(function (full) {
        var parsed = P.parseBook(full);
        parsed.sourceUpdatedAt = book.updated_at;
        var isUpdate = state.data && state.data.version !== parsed.version;
        adopt(parsed, 'live');
        saveCache(parsed);
        if (isUpdate) toast('Rules updated to v' + parsed.version);
        return true;
      });
    }).catch(function () {
      return false; // stay on the cached/built-in copy
    });
  }

  // ---------------------------------------------------------- pdf export

  var pdfPanel = $('pdfPanel');
  function populatePdfChapters() {
    var list = $('pdfChapterList');
    if (!state.data || !state.data.manuals.length) {
      list.innerHTML = '<div class="hint">No chapters loaded yet.</div>';
      return;
    }
    list.innerHTML = state.data.manuals.map(function (m) {
      return '<label><input type="checkbox" value="' + m.letter + '"> ' + m.letter + ' — ' + P.escapeHtml(m.title) + '</label>';
    }).join('');
  }
  function openPdfPanel() {
    populatePdfChapters();
    $('pdfMsg').textContent = '';
    if (typeof pdfPanel.showModal === 'function') pdfPanel.showModal();
    else pdfPanel.setAttribute('open', '');
  }
  $('pdfBtn').addEventListener('click', openPdfPanel);
  $('pdfPanelClose').addEventListener('click', function () { pdfPanel.close ? pdfPanel.close() : pdfPanel.removeAttribute('open'); });

  function generatePdf(chapters, includeCodes, includeGuides) {
    if (!state.data || !state.data.entries.length) { $('pdfMsg').textContent = 'No rules data loaded yet.'; return; }
    var html = BHAPdfExport.buildHtml(state.data.entries, state.data.manuals, {
      chapters: chapters, includeCodes: includeCodes, includeGuides: includeGuides,
      version: state.data.version, dateLabel: state.data.year, title: 'BHA Rules of Racing'
    });
    BHAPdfExport.openAndPrint(html);
  }

  $('pdfWholeBtn').addEventListener('click', function () {
    if (!state.data) return;
    generatePdf(state.data.manuals.map(function (m) { return m.letter; }), true, true);
  });

  $('pdfGenerate').addEventListener('click', function () {
    var chapters = Array.prototype.map.call($('pdfChapterList').querySelectorAll('input:checked'), function (i) { return i.value; });
    var includeCodes = $('pdfCodes').checked;
    var includeGuides = $('pdfGuides').checked;
    if (!chapters.length && !includeCodes && !includeGuides) {
      $('pdfMsg').textContent = 'Pick at least one chapter, or Codes & Guides, or the Guide Library.';
      return;
    }
    generatePdf(chapters, includeCodes, includeGuides);
  });

  // -------------------------------------------------------------- toast

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3500);
  }

  // -------------------------------------------------------------- start

  var cached = loadCache();
  var snap = loadSnapshot();
  var initial = null, source = 'none';
  if (cached && snap) {
    var newer = String(cached.sourceUpdatedAt || cached.publishedAt || '') >= String(snap.sourceUpdatedAt || snap.publishedAt || '');
    initial = newer ? cached : snap;
    source = newer ? 'cache' : 'snapshot';
  } else if (cached) { initial = cached; source = 'cache'; }
  else if (snap) { initial = snap; source = 'snapshot'; }

  if (initial) adopt(initial, source);
  else { renderTabs(); renderIdle(); }
  q.focus();
  loadGuides();
  loadOverrides();
  loadHistory();
  loadGlossary();
  refresh(!initial);
})();
