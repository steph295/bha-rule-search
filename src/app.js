/* BHA Rules Search — app logic. Runs against the index produced by parser.js. */
(function () {
  'use strict';

  var P = window.BHAParser;
  var API_HOST = 'https://rules.britishhorseracing.com';
  var LS_KEY = 'bha-rules-index-v1';
  var LS_CHECK = 'bha-rules-lastcheck-v1';
  var CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // background version check throttle
  var PAGE = 50;

  var state = {
    data: null,        // {version, publishedAt, manuals, entries, sourceUpdatedAt}
    source: 'none',    // snapshot | cache | live | pasted
    vocab: [],         // unique words for fuzzy matching
    corpus: '',        // all text concatenated, for cheap "does this word exist" checks
    shown: PAGE,
    activeIdx: -1,
    lastResults: [],
    lastTerms: []
  };

  var $ = function (id) { return document.getElementById(id); };
  var q = $('q'), results = $('results'), meta = $('meta'), status = $('status');

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
          return { id: e.id, code: e.code, num: e.num, kind: e.kind, doc: e.doc, letter: e.letter, title: e.title, path: e.path, html: e.html };
        })
      };
      localStorage.setItem(LS_KEY, JSON.stringify(slim));
    } catch (e) { /* quota — memory cache still works */ }
  }

  function adopt(data, source) {
    // derive the search text + display text for each entry if absent
    data.entries.forEach(function (e) {
      if (!e.plain) e.plain = P.toText(e.html);
      if (!e.text) {
        e.text = (e.title + ' ' + (e.path || []).join(' ') + ' ' + e.doc + ' ' + e.plain)
          .toLowerCase().replace(/\s+/g, ' ').trim();
      } else {
        e.text = e.text.toLowerCase();
      }
    });
    state.data = data;
    state.source = source;
    buildVocab();
    renderStatus();
    runSearch();
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

    var code = parseCodeQuery(tokens);
    var pool = entries;
    var codeMatched = false;
    var exactHit = false;

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

  function dispCode(e) {
    if (e.code) return '(' + e.letter + ')' + e.num;
    if (e.num != null) return '¶' + e.num;
    if (e.kind === 'code') return 'Code';
    if (e.kind === 'guide') return 'Guide';
    return 'Text';
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
      : 'Using ' + (state.source === 'cache' ? 'locally cached' : 'built-in') + ' copy — tap for details';
  }

  function renderIdle() {
    var d = state.data;
    results.innerHTML = '';
    meta.textContent = d ? d.entries.length + ' searchable rules and sections loaded' : 'Loading…';
    if (!d) return;
    var home = document.createElement('div');
    home.className = 'home';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.innerHTML = 'Search by rule code — <code>F45</code>, <code>(H)6</code> — or by keyword: <code>whip</code>, <code>interference</code>, <code>non-runner</code>, <code>weighing in</code>. Results appear as you type.';
    home.appendChild(hint);

    var h2 = document.createElement('h2');
    h2.textContent = 'Browse the rulebook';
    home.appendChild(h2);
    var chips = document.createElement('div');
    chips.className = 'chips';
    d.manuals.forEach(function (m) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.innerHTML = '<span class="cl">' + m.letter + '</span>' + P.escapeHtml(m.title);
      b.addEventListener('click', function () { q.value = m.letter; q.focus(); runSearch(); });
      chips.appendChild(b);
    });
    home.appendChild(chips);

    // codes + guides by document name
    var docs = {};
    d.entries.forEach(function (e) {
      if (e.kind === 'code' || e.kind === 'guide') docs[e.doc] = e.kind;
    });
    var names = Object.keys(docs);
    if (names.length) {
      var h3 = document.createElement('h2');
      h3.textContent = 'Codes & guides';
      home.appendChild(h3);
      var chips2 = document.createElement('div');
      chips2.className = 'chips';
      names.forEach(function (n) {
        var b = document.createElement('button');
        b.className = 'chip';
        b.textContent = n;
        b.addEventListener('click', function () { q.value = n.toLowerCase(); q.focus(); runSearch(); });
        chips2.appendChild(b);
      });
      home.appendChild(chips2);
    }
    results.appendChild(home);
  }

  function renderResults(res) {
    results.innerHTML = '';
    state.activeIdx = -1;
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
    var codeHtml = e.code
      ? '<span class="code">' + dispCode(e) + '</span>'
      : '<span class="code kind">' + dispCode(e) + '</span>';
    var pathBits = [e.doc].concat((e.path || []).slice(0, -1));
    head.innerHTML = codeHtml +
      '<span class="rtitle">' + highlight(P.escapeHtml(e.title), terms) + '</span>' +
      '<span class="rpath">' + P.escapeHtml(pathBits.join(' › ')) + '</span>';
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
    full.innerHTML = highlightHtml(e.html, state.lastTerms);
    div.appendChild(full);
    if (ex) ex.style.display = 'none';
    head.setAttribute('aria-expanded', 'true');
  }

  // ---------------------------------------------------------- interaction

  var debounceTimer = null;
  function runSearch() {
    var raw = q.value;
    $('clear').classList.toggle('show', !!raw.trim());
    if (!raw.trim()) { state.lastResults = []; state.lastTerms = []; state.shown = PAGE; renderIdle(); return; }
    var res = search(raw);
    state.lastResults = res.entries;
    state.lastTerms = res.terms;
    renderResults(res);
  }

  q.addEventListener('input', function () {
    state.shown = PAGE;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 70);
  });

  $('clear').addEventListener('click', function () {
    q.value = '';
    q.focus();
    runSearch();
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
    setPanelMsg('Checking for updates…');
    return getJSON('/api/books/', 20000).then(function (books) {
      try { localStorage.setItem(LS_CHECK, String(Date.now())); } catch (e) {}
      var book = pickBook(books);
      if (!book) throw new Error('no published book found');
      if (state.data && state.data.sourceUpdatedAt === book.updated_at) {
        state.source = 'live'; // confirmed current
        saveCache(state.data); // remember the verification across reloads
        renderStatus();
        setPanelMsg('Up to date — v' + state.data.version + ' is the latest published rulebook.');
        return false;
      }
      setPanelMsg('Downloading latest rulebook (v' + (book.version || '?') + ')…');
      return getJSON('/api/books/' + book.id + '?with=sections', 90000).then(function (full) {
        var parsed = P.parseBook(full);
        parsed.sourceUpdatedAt = book.updated_at;
        var isUpdate = state.data && state.data.version !== parsed.version;
        adopt(parsed, 'live');
        saveCache(parsed);
        setPanelMsg('Loaded v' + parsed.version + ' from the BHA site.');
        if (isUpdate) toast('Rules updated to v' + parsed.version);
        return true;
      });
    }).catch(function (err) {
      setPanelMsg('Could not reach the BHA site (' + err.message + '). Using the ' +
        (state.source === 'none' ? 'paste option below' : 'built-in copy') + '.');
      if (state.source === 'none') openPanel();
      return false;
    });
  }

  // -------------------------------------------------------------- panel

  var panel = $('panel');
  function openPanel() {
    $('paneldesc').textContent = state.data
      ? 'Rulebook v' + state.data.version + ' (' + (state.data.year || '') + ') — ' +
        state.data.entries.length + ' searchable entries. Source: ' +
        ({ live: 'fetched live from the BHA site', cache: 'saved locally from an earlier live fetch', snapshot: 'built into this page', pasted: 'pasted text', none: 'no data loaded' })[state.source] + '.'
      : 'No rules data loaded yet.';
    if (typeof panel.showModal === 'function') panel.showModal();
    else panel.setAttribute('open', '');
  }
  status.addEventListener('click', openPanel);
  $('panelclose').addEventListener('click', function () { panel.close ? panel.close() : panel.removeAttribute('open'); });
  $('checknow').addEventListener('click', function () { refresh(true); });
  function setPanelMsg(m) { $('panelmsg').textContent = m; }

  $('pastego').addEventListener('click', function () {
    var t = $('pastebox').value.trim();
    if (!t) { setPanelMsg('Paste the rules text or JSON first.'); return; }
    try {
      var parsed;
      if (t[0] === '{' || t[0] === '[') {
        var j = JSON.parse(t);
        var book = Array.isArray(j) ? null : (j.sections ? j : null);
        if (!book) throw new Error('JSON does not look like a rulebook (expected a book object with sections)');
        parsed = P.parseBook(book);
      } else {
        parsed = parsePastedText(t);
      }
      if (!parsed.entries.length) throw new Error('no rules recognised in that text');
      adopt(parsed, 'pasted');
      saveCache(parsed);
      setPanelMsg('Loaded ' + parsed.entries.length + ' entries from pasted content.');
      panel.close && panel.close();
      q.focus();
    } catch (err) {
      setPanelMsg('Could not parse that: ' + err.message);
    }
  });

  // Very forgiving plain-text importer: split on rule-code headings,
  // otherwise on blank lines.
  function parsePastedText(t) {
    var lines = t.split(/\r?\n/);
    var entries = [];
    var cur = null;
    var headRe = /^\s*\(?([A-Za-z])\)?\s*(\d{1,3})\b[.):\-\s]*(.*)$/;
    lines.forEach(function (line) {
      var m = headRe.exec(line);
      if (m && line.trim().length < 120) {
        cur = {
          code: m[1].toUpperCase() + m[2], num: +m[2], letter: m[1].toUpperCase(),
          kind: 'manual', doc: 'Pasted rules', title: m[3].trim() || ('Rule (' + m[1].toUpperCase() + ')' + m[2]),
          path: [], html: '', _t: []
        };
        entries.push(cur);
      } else if (line.trim()) {
        if (!cur) {
          cur = { code: null, num: null, letter: null, kind: 'guide', doc: 'Pasted rules', title: line.trim().slice(0, 80), path: [], html: '', _t: [] };
          entries.push(cur);
        }
        cur._t.push(line.trim());
      }
    });
    entries.forEach(function (e, i) {
      e.id = i;
      e.html = e._t.map(function (p) { return '<p class="l0">' + P.escapeHtml(p) + '</p>'; }).join('');
      delete e._t;
    });
    return { bookId: 0, version: 'pasted', publishedAt: null, year: null, manuals: [], entries: entries };
  }

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
  else renderIdle();
  q.focus();
  refresh(!initial);
})();
