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
    selectedKey: null
  };

  function isGuideEntry(e) { return e.kind === 'bhagi' || e.kind === 'guidedoc'; }
  function computeKey(e) { return e.code || (e.doc + '::' + e.title); }

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
      fetch('/overrides.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : { overrides: {} }; }).catch(function () { return { overrides: {} }; })
    ]).then(function (res) {
      var rules = res[0], guides = res[1], overrides = res[2];
      var entries = (rules.entries || []).map(function (e) {
        return { kind: e.kind, code: e.code, letter: e.letter, num: e.num, doc: e.doc, title: e.title, html: e.html, path: e.path || [] };
      }).concat((guides.entries || []).map(function (g) {
        return { kind: g.kind === 'bhagi' ? 'bhagi' : 'guidedoc', code: g.code, letter: null, num: null, doc: g.doc, title: g.title, html: g.html, path: [g.cat] };
      }));
      entries.forEach(function (e) { e.key = computeKey(e); });
      state.entries = entries;
      state.overrides = overrides.overrides || {};
      state.manuals = rules.manuals || [];
      state.version = rules.version;
      state.year = rules.year;
      renderList();
      populatePdfChapters();
    }).catch(function (e) {
      $('resultList').innerHTML = '<div class="empty-state">Could not load rule data: ' + escapeHtml(e.message) + '</div>';
    });
  }

  // ---- list / filter ----------------------------------------------------

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.addEventListener('click', function () {
      state.tab = b.dataset.tab;
      Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) { x.classList.toggle('active', x === b); });
      renderList();
    });
  });
  $('search').addEventListener('input', function () { state.query = $('search').value.toLowerCase(); renderList(); });

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
    renderList();
    var e = state.entries.filter(function (x) { return x.key === key; })[0];
    if (!e) return;
    var eff = effective(e);
    var pane = $('editorPane');
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
      renderList();
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
