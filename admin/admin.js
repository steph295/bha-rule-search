/* BHA Rules Admin — talks to the same-origin /api/* functions (deployed
 * alongside this page on Vercel) and reads the public rules.json/guides.json
 * /overrides.json that the main app.js also reads. Editing here writes
 * straight to overrides.json in the GitHub repo; the public site picks up
 * the change on its next load (no rebuild, no redeploy of index.html). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    loggedIn: false,
    entries: [],       // [{key, kind, code, doc, title, html, path}] — ORIGINAL, pre-override
    overrides: {},      // key -> {title, html, updatedAt}
    tab: 'all',
    query: '',
    selectedKey: null,
    manualsView: 'home', // home | list | reader
    readerBook: null,    // 'rules' | 'guides' | 'bhagi'
    readerTree: null,
    definitions: [],        // [{id, term, html, slug}] — ORIGINAL, pre-override
    definitionOverrides: {}, // termId -> {html, updatedAt}
    defQuery: '',
    selectedDefId: null
  };

  function isGuideEntry(e) { return e.kind === 'bhagi' || e.kind === 'guidedoc'; }
  function computeKey(e) { return e.code || (e.doc + '::' + e.title); }
  function codeClass(e) {
    if (e.kind === 'bhagi') return 'code bhagi';
    if (e.kind === 'guidedoc') return 'code guidedoc';
    return 'code';
  }
  function dispCode(e) {
    return e.code || (e.kind === 'code' || e.kind === 'guide' ? 'Code' : e.kind === 'bhagi' ? 'BHAGI' : 'Guide');
  }

  function stripHtml(html) {
    return String(html || '')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      // decode specific entities before &amp; itself, else "&amp;nbsp;" etc
      // would decode in two passes and re-escape wrong on the next save
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function plainTextToHtml(text) {
    var paras = String(text || '').split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    return paras.map(function (p) {
      return '<p class="l0">' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  function effective(e) {
    var o = state.overrides[e.key];
    return {
      title: (o && o.title) || e.title,
      html: (o && o.html) || e.html,
      edited: !!o
    };
  }

  // ---- auth ---------------------------------------------------------

  function checkSession() {
    return fetch('/api/session').then(function (r) { return r.json(); }).then(function (j) {
      state.loggedIn = !!j.loggedIn;
      render();
      if (state.loggedIn) loadData();
    });
  }

  $('loginBtn').addEventListener('click', doLogin);
  $('pw').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doLogin(); });

  function doLogin() {
    var pw = $('pw').value;
    $('loginError').textContent = '';
    fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'sign-in failed'); });
      return r.json();
    }).then(function () {
      $('pw').value = '';
      state.loggedIn = true;
      render();
      loadData();
    }).catch(function (e) { $('loginError').textContent = e.message; });
  }

  $('logoutBtn').addEventListener('click', function () {
    fetch('/api/logout', { method: 'POST' }).then(function () {
      state.loggedIn = false;
      render();
    });
  });

  // ---- data -----------------------------------------------------------

  function loadData() {
    Promise.all([
      fetch('/rules.json').then(function (r) { return r.json(); }),
      fetch('/guides.json').then(function (r) { return r.json(); }).catch(function () { return { entries: [] }; }),
      fetch('/overrides.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : { overrides: {}, definitionOverrides: {} }; }).catch(function () { return { overrides: {}, definitionOverrides: {} }; }),
      fetch('/definitions.json').then(function (r) { return r.json(); }).catch(function () { return { terms: [] }; })
    ]).then(function (res) {
      var rules = res[0], guides = res[1], overrides = res[2], definitions = res[3];
      var entries = (rules.entries || []).map(function (e) {
        return { kind: e.kind, code: e.code, letter: e.letter, num: e.num, doc: e.doc, title: e.title, html: e.html, path: e.path || [] };
      }).concat((guides.entries || []).map(function (g) {
        return { kind: g.kind === 'bhagi' ? 'bhagi' : 'guidedoc', code: g.code, letter: null, num: null, doc: g.doc, title: g.title, html: g.html, path: [g.cat] };
      }));
      entries.forEach(function (e) { e.key = computeKey(e); });
      state.entries = entries;
      state.overrides = overrides.overrides || {};
      state.definitionOverrides = overrides.definitionOverrides || {};
      state.definitions = definitions.terms || [];
      state.manuals = rules.manuals || [];
      state.version = rules.version;
      state.year = rules.year;
      updateManualsViewFromFilters();
      populatePdfChapters();
      renderDefinitionsList();
    }).catch(function (e) {
      $('resultList').innerHTML = '<div class="empty-state">Could not load rule data: ' + escapeHtml(e.message) + '</div>';
    });
  }

  function effectiveDefinition(t) {
    var o = state.definitionOverrides[t.id];
    return { html: (o && o.html) || t.html, edited: !!o };
  }

  // ---- list / filter ----------------------------------------------------

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.addEventListener('click', function () {
      state.tab = b.dataset.tab;
      Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) { x.classList.toggle('active', x === b); });
      updateManualsViewFromFilters();
    });
  });
  $('search').addEventListener('input', function () { state.query = $('search').value.toLowerCase(); updateManualsViewFromFilters(); });

  // ---- home / list / reader view switching ------------------------------

  function renderManualsView() {
    var v = state.manualsView;
    $('manualsToolbar').style.display = v === 'reader' ? 'none' : '';
    $('homeCards').style.display = v === 'home' ? '' : 'none';
    $('listAndEditor').style.display = v === 'list' ? 'flex' : 'none';
    $('readerView').hidden = v !== 'reader';
  }

  function updateManualsViewFromFilters() {
    state.manualsView = (state.tab === 'all' && !state.query) ? 'home' : 'list';
    renderManualsView();
    if (state.manualsView === 'home') renderHomeCards();
    else renderList();
  }

  var DOC_ICONS = {
    book: '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h8.5A1.5 1.5 0 0 1 13 4v9.5H4.5A1.5 1.5 0 0 1 3 12V2.5z"></path><path d="M3 11.5A1.5 1.5 0 0 1 4.5 10H13"></path></svg>',
    library: '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5v9M6 3v9.5M9.5 3.5l3 9"></path></svg>',
    bhagi: '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2.5" width="10" height="11" rx="1.2"></rect><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"></path></svg>'
  };

  function docCard(icon, title, meta, onClick) {
    var card = document.createElement('div');
    card.className = 'doc-card';
    card.innerHTML = '<span class="doc-icon">' + DOC_ICONS[icon] + '</span>' +
      '<span class="doc-info"><span class="doc-title">' + escapeHtml(title) + '</span>' +
      '<span class="doc-meta">' + escapeHtml(meta) + '</span></span>';
    card.addEventListener('click', onClick);
    return card;
  }

  function renderHomeCards() {
    var wrap = $('homeCards');
    wrap.innerHTML = '';
    if (!state.entries.length) return;
    var ruleEntries = state.entries.filter(function (e) { return !isGuideEntry(e); });
    var guideEntries = state.entries.filter(isGuideEntry);
    var bhagiEntries = state.entries.filter(function (e) { return e.kind === 'bhagi'; });
    var bhagiDocs = {};
    bhagiEntries.forEach(function (e) { bhagiDocs[e.doc] = 1; });

    wrap.appendChild(docCard('book', 'Rules of Racing',
      'v' + state.version + ' · ' + (state.year || '') + ' · ' + ruleEntries.length + ' entries',
      function () { enterReader('rules'); }));
    wrap.appendChild(docCard('library', 'Guide Library',
      guideEntries.length + ' entries',
      function () { enterReader('guides'); }));
    wrap.appendChild(docCard('bhagi', 'BHAGIs',
      Object.keys(bhagiDocs).length + ' sections · ' + bhagiEntries.length + ' entries',
      function () { enterReader('bhagi'); }));
  }

  // ---- reader (outline + full text + inline edit) ------------------------

  function buildPathTree(entries, nextId) {
    var root = { id: null, label: null, badge: null, children: [], entries: [], _map: {} };
    entries.forEach(function (e) {
      var segs = (e.path || []).slice(0, -1);
      var node = root;
      segs.forEach(function (seg) {
        if (!seg) return;
        if (!node._map[seg]) {
          var child = { id: nextId(), label: seg, badge: null, children: [], entries: [], _map: {} };
          node._map[seg] = child;
          node.children.push(child);
        }
        node = node._map[seg];
      });
      node.entries.push(e);
    });
    return root;
  }

  function buildRulesOutline(manuals, entries) {
    var seq = 0;
    function nextId() { return 'sec' + (seq++); }
    var top = [];
    (manuals || []).forEach(function (m) {
      var manEntries = entries.filter(function (e) { return e.letter === m.letter; });
      if (!manEntries.length) return;
      var node = buildPathTree(manEntries, nextId);
      node.id = nextId(); node.label = m.title; node.badge = m.letter;
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
      node.id = nextId(); node.label = docName;
      top.push(node);
    });
    return top;
  }

  function buildGuidesOutline(entries) {
    var seq = 0;
    function nextId() { return 'gsec' + (seq++); }
    var cats = {}, order = [];
    entries.forEach(function (e) {
      var cat = (e.path && e.path[0]) || 'Guides';
      if (!cats[cat]) { cats[cat] = { id: nextId(), label: cat, badge: null, children: [], entries: [], _docs: {} }; order.push(cat); }
      var catNode = cats[cat];
      if (!catNode._docs[e.doc]) {
        var docNode = { id: nextId(), label: e.doc, badge: null, children: [], entries: [] };
        catNode._docs[e.doc] = docNode;
        catNode.children.push(docNode);
      }
      catNode._docs[e.doc].entries.push(e);
    });
    return order.map(function (c) { return cats[c]; });
  }

  function entryMatchesTokens(e, tokens) {
    if (!tokens.length) return true;
    var eff = effective(e);
    var hay = (eff.title + ' ' + e.doc + ' ' + (e.code || '') + ' ' + stripHtml(eff.html)).toLowerCase();
    return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function filterOutlineTree(nodes, tokens) {
    var out = [];
    nodes.forEach(function (n) {
      var matchedEntries = n.entries.filter(function (e) { return entryMatchesTokens(e, tokens); });
      var filteredChildren = filterOutlineTree(n.children, tokens);
      if (!tokens.length || matchedEntries.length || filteredChildren.length) {
        out.push({ id: n.id, label: n.label, badge: n.badge, entries: matchedEntries, children: filteredChildren });
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
      row.innerHTML = (n.badge ? '<span class="code">' + escapeHtml(n.badge) + '</span>' : '') + '<span>' + escapeHtml(n.label) + '</span>';
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

  function renderReaderSection(n, depth) {
    var frag = document.createDocumentFragment();
    var head = document.createElement('div');
    head.id = n.id;
    head.dataset.outlineId = n.id;
    head.className = 'reader-heading depth-' + depth;
    head.innerHTML = (n.badge ? '<span class="code">' + escapeHtml(n.badge) + '</span>' : '') + escapeHtml(n.label);
    frag.appendChild(head);
    n.entries.forEach(function (e) {
      var eff = effective(e);
      var block = document.createElement('div');
      block.className = 'reader-entry' + (e.key === state.selectedKey ? ' selected' : '');
      block.dataset.key = e.key;
      block.innerHTML = '<div class="reader-entry-head">' +
        '<span class="' + codeClass(e) + '">' + escapeHtml(dispCode(e)) + '</span>' +
        '<span class="reader-entry-title">' + escapeHtml(eff.title) + '</span>' +
        (eff.edited ? '<span class="edited-dot" title="Has a published edit"></span>' : '') +
        '<button type="button" class="reader-entry-edit">Edit</button></div>' +
        '<div class="rfull-body">' + eff.html + '</div>';
      block.querySelector('.reader-entry-edit').addEventListener('click', function (ev) {
        ev.stopPropagation();
        selectEntry(e.key);
      });
      frag.appendChild(block);
    });
    n.children.forEach(function (c) { frag.appendChild(renderReaderSection(c, depth + 1)); });
    return frag;
  }

  var readerScrollHandler = null;
  function teardownScrollSpy() {
    if (readerScrollHandler) { window.removeEventListener('scroll', readerScrollHandler); readerScrollHandler = null; }
  }
  function setupScrollSpy(container) {
    teardownScrollSpy();
    var ticking = false;
    function update() {
      ticking = false;
      var headings = Array.prototype.slice.call(container.querySelectorAll('[data-outline-id]'));
      var activeId = headings.length ? headings[0].dataset.outlineId : null;
      for (var i = 0; i < headings.length; i++) {
        if (headings[i].getBoundingClientRect().top - 90 <= 0) activeId = headings[i].dataset.outlineId;
        else break;
      }
      Array.prototype.forEach.call(document.querySelectorAll('.outline-link'), function (a) {
        a.classList.toggle('active', a.dataset.target === activeId);
      });
    }
    readerScrollHandler = function () { if (ticking) return; ticking = true; window.requestAnimationFrame(update); };
    window.addEventListener('scroll', readerScrollHandler, { passive: true });
    update();
  }

  function renderReaderBody(rawQuery) {
    var tokens = rawQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var filtered = filterOutlineTree(state.readerTree, tokens);

    var navList = $('readerOutlineList');
    navList.innerHTML = '';
    navList.appendChild(renderOutlineNav(filtered, 0));

    var entriesEl = $('readerEntries');
    entriesEl.innerHTML = '';
    var countEl = $('readerCount');
    if (tokens.length) {
      var n = countOutlineEntries(filtered);
      countEl.textContent = n + (n === 1 ? ' match' : ' matches');
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
    if (tokens.length && !filtered.length) {
      entriesEl.innerHTML = '<div class="empty-state">Nothing matches that.</div>';
    } else {
      filtered.forEach(function (n) { entriesEl.appendChild(renderReaderSection(n, 0)); });
    }
    teardownScrollSpy();
    if (!tokens.length) setupScrollSpy(entriesEl);
  }

  function renderReader() {
    var book = state.readerBook;
    var titleText = book === 'guides' ? 'Guide Library' : book === 'bhagi' ? 'BHAGIs' : 'Rules of Racing';
    $('readerTitle').textContent = titleText;

    var pool = book === 'guides' ? state.entries.filter(isGuideEntry)
      : book === 'bhagi' ? state.entries.filter(function (e) { return e.kind === 'bhagi'; })
      : state.entries.filter(function (e) { return !isGuideEntry(e); });

    state.readerTree = (book === 'guides' || book === 'bhagi')
      ? buildGuidesOutline(pool)
      : buildRulesOutline(state.manuals, pool);

    $('readerSearch').value = '';
    $('readerEditorSlot').innerHTML = '<div class="empty-state">Click Edit on any entry to change it.</div>';
    renderReaderBody('');
  }

  function enterReader(book) {
    state.manualsView = 'reader';
    state.readerBook = book;
    state.selectedKey = null;
    renderManualsView();
    renderReader();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('readerBack').addEventListener('click', function () {
    teardownScrollSpy();
    updateManualsViewFromFilters();
  });

  var readerSearchDebounce = null;
  $('readerSearch').addEventListener('input', function () {
    clearTimeout(readerSearchDebounce);
    var val = this.value;
    readerSearchDebounce = setTimeout(function () { renderReaderBody(val); }, 80);
  });

  function matchesTab(e) {
    if (state.tab === 'rules') return !isGuideEntry(e);
    if (state.tab === 'guides') return isGuideEntry(e);
    if (state.tab === 'edited') return !!state.overrides[e.key];
    return true;
  }

  function renderList() {
    var q = state.query;
    var rows = state.entries.filter(function (e) {
      if (!matchesTab(e)) return false;
      if (!q) return true;
      var eff = effective(e);
      return (e.code || '').toLowerCase().indexOf(q) !== -1 ||
        eff.title.toLowerCase().indexOf(q) !== -1 ||
        e.doc.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 300);

    var list = $('resultList');
    list.innerHTML = '';
    if (!rows.length) { list.innerHTML = '<div class="empty-state">No matches.</div>'; return; }

    var frag = document.createDocumentFragment();
    rows.forEach(function (e) {
      var eff = effective(e);
      var row = document.createElement('div');
      row.className = 'result-row' + (e.key === state.selectedKey ? ' active' : '');
      var codeClass = e.kind === 'bhagi' ? 'code bhagi' : (e.kind === 'guidedoc' ? 'code guidedoc' : 'code');
      var codeLabel = e.code || (e.kind === 'code' || e.kind === 'guide' ? 'Code' : e.kind === 'bhagi' ? 'BHAGI' : 'Guide');
      row.innerHTML = '<span class="' + codeClass + '">' + escapeHtml(codeLabel) + '</span>' +
        '<span class="title">' + escapeHtml(eff.title) + '</span>' +
        (eff.edited ? '<span class="edited-dot" title="Has a published edit"></span>' : '') +
        '<span class="doc">' + escapeHtml(e.doc) + '</span>';
      row.addEventListener('click', function () { selectEntry(e.key); });
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  // ---- editor -----------------------------------------------------------

  function selectEntry(key) {
    state.selectedKey = key;
    if (state.manualsView === 'reader') renderReaderBody($('readerSearch').value);
    else renderList();
    var e = state.entries.filter(function (x) { return x.key === key; })[0];
    if (!e) return;
    var eff = effective(e);
    var pane = state.manualsView === 'reader' ? $('readerEditorSlot') : $('editorPane');
    pane.innerHTML =
      '<div class="editor-card">' +
      '<span class="code-badge">' + escapeHtml(e.code || e.kind) + '</span>' +
      '<div style="font-size:12.5px;color:#5a6660">' + escapeHtml(e.doc) + (e.path.length ? ' &rsaquo; ' + e.path.map(escapeHtml).join(' &rsaquo; ') : '') + '</div>' +
      '<label for="editTitle">Title</label>' +
      '<input type="text" id="editTitle" value="' + escapeHtml(eff.title) + '">' +
      '<label for="editBody">Body text</label>' +
      '<textarea id="editBody"></textarea>' +
      '<div class="hint">Plain text — blank lines start a new paragraph. This replaces the formatted sub-clauses (45.1, 45.2 …) with plain paragraphs; it does not preserve the original numbering structure.</div>' +
      '<div class="editor-actions">' +
      '<button class="save" id="saveBtn">Publish change</button>' +
      (eff.edited ? '<span class="hint" style="margin:0">Edited ' + new Date(state.overrides[key].updatedAt).toLocaleString() + '</span>' : '') +
      '</div>' +
      '<div class="save-msg" id="saveMsg"></div>' +
      '</div>';
    $('editBody').value = stripHtml(eff.html);
    $('saveBtn').addEventListener('click', function () { confirmSave(e); });
  }

  function confirmSave(e) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>Publish this change?</h3>' +
      '<p>This goes live on the public site immediately — there is no draft or review step to undo it from here (though every change is a normal git commit, so it can always be reverted from GitHub).</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Publish now</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      doSave(e);
    });
  }

  function doSave(e) {
    var title = $('editTitle').value.trim();
    var bodyText = $('editBody').value;
    var html = plainTextToHtml(bodyText);
    var msg = $('saveMsg');
    var btn = $('saveBtn');
    btn.disabled = true;
    msg.textContent = 'Publishing…';
    msg.className = 'save-msg';

    fetch('/api/save-rule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: e.key, title: title, html: html })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'save failed'); });
      return r.json();
    }).then(function () {
      state.overrides[e.key] = { title: title, html: html, updatedAt: new Date().toISOString() };
      msg.textContent = 'Published — live on the public site now.';
      msg.className = 'save-msg ok';
      btn.disabled = false;
      if (state.manualsView === 'reader') renderReaderBody($('readerSearch').value);
      else renderList();
    }).catch(function (err) {
      msg.textContent = 'Could not publish: ' + err.message;
      msg.className = 'save-msg err';
      btn.disabled = false;
    });
  }

  // ---- word definitions (glossary) --------------------------------------

  $('defSearch').addEventListener('input', function () {
    state.defQuery = $('defSearch').value.toLowerCase();
    renderDefinitionsList();
  });

  function renderDefinitionsList() {
    var q = state.defQuery;
    var rows = state.definitions.filter(function (t) {
      return !q || t.term.toLowerCase().indexOf(q) !== -1;
    });
    $('defCount').textContent = state.definitions.length ? rows.length + ' of ' + state.definitions.length + ' terms' : '';

    var list = $('defResultList');
    list.innerHTML = '';
    if (!rows.length) { list.innerHTML = '<div class="empty-state">No matches.</div>'; return; }

    var frag = document.createDocumentFragment();
    rows.forEach(function (t) {
      var eff = effectiveDefinition(t);
      var row = document.createElement('div');
      row.className = 'result-row' + (t.id === state.selectedDefId ? ' active' : '');
      row.innerHTML = '<span class="title">' + escapeHtml(t.term) + '</span>' +
        (eff.edited ? '<span class="edited-dot" title="Has a published edit"></span>' : '');
      row.addEventListener('click', function () { selectDefinition(t.id); });
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  function selectDefinition(id) {
    state.selectedDefId = id;
    renderDefinitionsList();
    var t = state.definitions.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var eff = effectiveDefinition(t);
    var pane = $('defEditorPane');
    pane.innerHTML =
      '<div class="editor-card">' +
      '<span class="code-badge">' + escapeHtml(t.term) + '</span>' +
      '<label for="defBody">Definition</label>' +
      '<textarea id="defBody"></textarea>' +
      '<div class="hint">Plain text — blank lines start a new paragraph. The term itself isn’t editable here, since it’s what the public site matches against in the rule text.</div>' +
      '<div class="editor-actions">' +
      '<button class="save" id="defSaveBtn">Publish change</button>' +
      (eff.edited ? '<span class="hint" style="margin:0">Edited ' + new Date(state.definitionOverrides[id].updatedAt).toLocaleString() + '</span>' : '') +
      '</div>' +
      '<div class="save-msg" id="defSaveMsg"></div>' +
      '</div>';
    $('defBody').value = stripHtml(eff.html);
    $('defSaveBtn').addEventListener('click', function () { confirmSaveDefinition(t); });
  }

  function confirmSaveDefinition(t) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>Publish this definition?</h3>' +
      '<p>This goes live on the public site immediately — there is no draft or review step to undo it from here (though every change is a normal git commit, so it can always be reverted from GitHub).</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Publish now</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      doSaveDefinition(t);
    });
  }

  function doSaveDefinition(t) {
    var bodyText = $('defBody').value;
    var html = plainTextToHtml(bodyText);
    var msg = $('defSaveMsg');
    var btn = $('defSaveBtn');
    btn.disabled = true;
    msg.textContent = 'Publishing…';
    msg.className = 'save-msg';

    fetch('/api/save-definition', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ termId: t.id, html: html })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'save failed'); });
      return r.json();
    }).then(function () {
      state.definitionOverrides[t.id] = { html: html, updatedAt: new Date().toISOString() };
      msg.textContent = 'Published — live on the public site now.';
      msg.className = 'save-msg ok';
      btn.disabled = false;
      renderDefinitionsList();
    }).catch(function (err) {
      msg.textContent = 'Could not publish: ' + err.message;
      msg.className = 'save-msg err';
      btn.disabled = false;
    });
  }

  // ---- render -------------------------------------------------------

  function render() {
    $('loginView').style.display = state.loggedIn ? 'none' : '';
    $('appShell').style.display = state.loggedIn ? 'flex' : 'none';
    $('who').style.display = state.loggedIn ? 'flex' : 'none';
  }

  // ---- sidebar navigation ---------------------------------------------

  Array.prototype.forEach.call(document.querySelectorAll('.navitem'), function (item) {
    item.addEventListener('click', function () {
      var view = item.dataset.view;
      Array.prototype.forEach.call(document.querySelectorAll('.navitem'), function (x) {
        x.classList.toggle('active', x === item);
      });
      Array.prototype.forEach.call(document.querySelectorAll('.view'), function (x) {
        x.classList.toggle('active', x.id === 'view-' + view);
      });
    });
  });
  // "Manuals" is the working screen and the default view.
  document.getElementById('view-manuals').classList.add('active');

  // ---- pdf export -------------------------------------------------------

  var pdfPanel = $('pdfPanel');
  function populatePdfChapters() {
    var list = $('pdfChapterList');
    if (!list) return;
    if (!state.manuals || !state.manuals.length) { list.innerHTML = '<div class="hint">No chapters loaded yet.</div>'; return; }
    list.innerHTML = state.manuals.map(function (m) {
      return '<label><input type="checkbox" value="' + m.letter + '"> ' + m.letter + ' — ' + escapeHtml(m.title) + '</label>';
    }).join('');
  }
  function openPdfPanel() {
    $('pdfMsg').textContent = '';
    if (typeof pdfPanel.showModal === 'function') pdfPanel.showModal();
    else pdfPanel.setAttribute('open', '');
  }
  if ($('pdfBtn')) $('pdfBtn').addEventListener('click', openPdfPanel);
  if ($('pdfPanelClose')) $('pdfPanelClose').addEventListener('click', function () { pdfPanel.close ? pdfPanel.close() : pdfPanel.removeAttribute('open'); });

  function effectiveEntries() {
    return state.entries.map(function (e) {
      var eff = effective(e);
      return { kind: e.kind, code: e.code, letter: e.letter, num: e.num, doc: e.doc, path: e.path, title: eff.title, html: eff.html };
    });
  }

  function generatePdf(chapters, includeCodes, includeGuides) {
    if (!state.entries.length) { $('pdfMsg').textContent = 'No rules data loaded yet.'; return; }
    var html = BHAPdfExport.buildHtml(effectiveEntries(), state.manuals, {
      chapters: chapters, includeCodes: includeCodes, includeGuides: includeGuides,
      version: state.version, dateLabel: state.year, title: 'BHA Rules of Racing'
    });
    BHAPdfExport.openAndPrint(html);
  }

  if ($('pdfWholeBtn')) $('pdfWholeBtn').addEventListener('click', function () {
    generatePdf((state.manuals || []).map(function (m) { return m.letter; }), true, true);
  });

  if ($('pdfGenerate')) $('pdfGenerate').addEventListener('click', function () {
    var chapters = Array.prototype.map.call($('pdfChapterList').querySelectorAll('input:checked'), function (i) { return i.value; });
    var includeCodes = $('pdfCodes').checked;
    var includeGuides = $('pdfGuides').checked;
    if (!chapters.length && !includeCodes && !includeGuides) {
      $('pdfMsg').textContent = 'Pick at least one chapter, or Codes & Guides, or the Guide Library.';
      return;
    }
    generatePdf(chapters, includeCodes, includeGuides);
  });

  checkSession();
})();
