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
    readerNewOnly: false,
    readerEditMode: false,
    definitions: [],        // [{id, term, html, slug}] — ORIGINAL, pre-override
    definitionOverrides: {}, // termId -> {html, updatedAt}
    defQuery: '',
    selectedDefId: null,
    bookOverrides: {}, // 'rules'|'guides'|'bhagi' -> {title, whatsNew, updatedAt}
    customDefinitions: {}, // id -> {term, html, updatedAt} — admin-added terms not in BHA's own Definitions chapter
    uploadedGuides: {}, // id -> {title, cat, dated, url, html, updatedAt} — admin-uploaded Guide Library PDFs
    mediaPath: 'uploads', // current folder browsed in the Media Library
    mediaItems: null,     // [{name, path, type, size, url}] for state.mediaPath, or null while loading
    users: null           // email -> {name, grantedAt}, or null while loading — see loadUsers()
  };

  function isGuideEntry(e) { return e.kind === 'bhagi' || e.kind === 'guidedoc'; }
  function computeKey(e) { return e.code || (e.doc + '::' + e.title); }
  function codeClass(e) {
    if (e.kind === 'bhagi') return 'code bhagi';
    if (e.kind === 'guidedoc') return 'code guidedoc';
    return 'code';
  }
  function dispCode(e) {
    // An admin-added rule's .code is a permanent internal id, not something
    // to show anyone — display its letter+number instead, same as any
    // original rule (its display never depended on .code's actual value).
    if (e._addedId) return (e.letter || '') + (e.num != null ? e.num : '');
    return e.code || (e.kind === 'code' || e.kind === 'guide' ? 'Code' : e.kind === 'bhagi' ? 'BHAGI' : 'Guide');
  }

  function stripHtml(html) {
    return String(html || '')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // keep <b>/<i>/<u>/<sub>/<sup> (and their closing tags) — everything
      // else goes, same inline-tag whitelist plainTextToHtml/
      // escapeHtmlAllowInline re-escape back in on save
      .replace(/<(?!\/?(?:b|i|u|sub|sup)>)[^>]+>/gi, '')
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

  // Same as escapeHtml, but lets the three inline tags the toolbar's
  // Bold/Italic/Underline buttons insert survive — everything else the
  // admin types is still escaped, so this can't be used to inject arbitrary
  // markup, only the exact <b>/<i>/<u> pairs those buttons produce.
  var INLINE_TAGS = ['b', 'i', 'u', 'sub', 'sup'];
  function escapeHtmlAllowInline(s) {
    var esc = escapeHtml(s);
    INLINE_TAGS.forEach(function (tag) {
      esc = esc.replace(new RegExp('&lt;' + tag + '&gt;', 'gi'), '<' + tag + '>')
        .replace(new RegExp('&lt;/' + tag + '&gt;', 'gi'), '</' + tag + '>');
    });
    return esc;
  }

  function plainTextToHtml(text) {
    var paras = String(text || '').split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    return paras.map(function (p) {
      return '<p class="l0">' + escapeHtmlAllowInline(p).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  // flag is one of: 'new' | 'updated' | 'none' (explicitly not flagged) |
  // undefined/'' (auto — defers to the BHA's own highlighted-in-source
  // detection, e.solNew). 'not-new' is accepted too, as an alias for 'none'
  // — earlier overrides published before "Updated" existed used that name.
  function effective(e) {
    // An added entry (no BHA original — see api/save-rule.js) keeps its own
    // content in addedEntries rather than the overrides patch layer.
    var o = e._addedId ? state.addedEntries[e._addedId] : state.overrides[e.key];
    var flag = o && (o.flag === 'not-new' ? 'none' : o.flag);
    return {
      title: (o && o.title) || e.title,
      html: (o && o.html) || e.html,
      isNew: flag === 'new' ? true : flag ? false : !!e.isNew,
      isUpdated: flag === 'updated',
      edited: !e._addedId && !!o
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

  // ---- collapsible sidebar ------------------------------------------
  var SIDEBAR_LS_KEY = 'bha-admin-sidebar-collapsed';
  try {
    if (localStorage.getItem(SIDEBAR_LS_KEY) === '1') document.body.classList.add('sidebar-collapsed');
  } catch (e) { /* private mode etc — just default to expanded */ }
  $('sidebarCollapseToggle').addEventListener('click', function () {
    var collapsed = document.body.classList.toggle('sidebar-collapsed');
    try { localStorage.setItem(SIDEBAR_LS_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
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
      var uploadedGuides = overrides.uploadedGuides || {};
      var uploadedGuideEntries = Object.keys(uploadedGuides).map(function (id) {
        var u = uploadedGuides[id];
        return { kind: 'guide', code: null, doc: u.title, cat: u.cat, title: u.title, html: u.html, _uploadId: id };
      });
      var deletedEntries = overrides.deletedEntries || {};
      var addedEntries = overrides.addedEntries || {};
      var addedRuleEntries = Object.keys(addedEntries).map(function (id) {
        var a = addedEntries[id];
        return { kind: 'manual', code: id, letter: a.letter, num: a.num, doc: a.doc, title: a.title, html: a.html, path: a.path || [], isNew: false, _addedId: id };
      });
      var entries = (rules.entries || []).map(function (e) {
        return { kind: e.kind, code: e.code, letter: e.letter, num: e.num, doc: e.doc, title: e.title, html: e.html, path: e.path || [], isNew: !!e.isNew };
      }).concat(addedRuleEntries).concat((guides.entries || []).concat(uploadedGuideEntries).map(function (g) {
        return { kind: g.kind === 'bhagi' ? 'bhagi' : 'guidedoc', code: g.code, letter: null, num: null, doc: g.doc, title: g.title, html: g.html, path: [g.cat], _uploadId: g._uploadId };
      }));
      entries.forEach(function (e) { e.key = e._uploadId || e._addedId || computeKey(e); });
      // deletedEntries hides an ORIGINAL entry from rules.json's own fixed
      // list — an added entry that's removed is deleted outright from
      // addedEntries server-side instead, so never appears here at all.
      if (Object.keys(deletedEntries).length) entries = entries.filter(function (e) { return !deletedEntries[e.key]; });
      state.entries = entries;
      state.overrides = overrides.overrides || {};
      state.definitionOverrides = overrides.definitionOverrides || {};
      state.bookOverrides = overrides.bookOverrides || {};
      state.customDefinitions = overrides.customDefinitions || {};
      state.uploadedGuides = uploadedGuides;
      state.addedEntries = addedEntries;
      state.deletedEntries = deletedEntries;
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

  function effectiveBookMeta(key, fallbackTitle) {
    var o = state.bookOverrides[key];
    return { title: (o && o.title) || fallbackTitle, whatsNew: (o && o.whatsNew) || '', edited: !!o };
  }

  // ---- list / filter ----------------------------------------------------

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.addEventListener('click', function () {
      state.tab = b.dataset.tab;
      Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-selected', x === b ? 'true' : 'false');
      });
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
    document.body.classList.toggle('reader-mode', v === 'reader');
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

  function docCard(icon, title, meta, onClick, opts) {
    opts = opts || {};
    var card = document.createElement('div');
    card.className = 'doc-card';
    card.innerHTML = '<span class="doc-icon">' + DOC_ICONS[icon] + '</span>' +
      '<span class="doc-info"><span class="doc-title">' + escapeHtml(title) + '</span>' +
      '<span class="doc-meta">' + escapeHtml(meta) + '</span>' +
      (opts.whatsNew ? '<span class="doc-whatsnew">What’s new: ' + escapeHtml(opts.whatsNew) + '</span>' : '') +
      '</span>';
    card.addEventListener('click', onClick);
    if (opts.onEdit) {
      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'doc-edit-btn';
      editBtn.title = 'Edit book details';
      editBtn.setAttribute('aria-label', 'Edit book details');
      editBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z"></path></svg>';
      editBtn.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onEdit(); });
      card.appendChild(editBtn);
    }
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

    var rulesMeta = effectiveBookMeta('rules', 'Rules of Racing');
    wrap.appendChild(docCard('book', rulesMeta.title,
      'v' + state.version + ' · ' + (state.year || '') + ' · ' + ruleEntries.length + ' entries',
      function () { enterReader('rules'); },
      { whatsNew: rulesMeta.whatsNew, onEdit: function () { openBookMetaPanel('rules', 'Rules of Racing'); } }));
    var guidesMeta = effectiveBookMeta('guides', 'Guide Library');
    wrap.appendChild(docCard('library', guidesMeta.title,
      guideEntries.length + ' entries',
      function () { enterReader('guides'); },
      { whatsNew: guidesMeta.whatsNew, onEdit: function () { openBookMetaPanel('guides', 'Guide Library'); } }));
    var bhagiMeta = effectiveBookMeta('bhagi', 'BHAGIs');
    wrap.appendChild(docCard('bhagi', bhagiMeta.title,
      Object.keys(bhagiDocs).length + ' sections · ' + bhagiEntries.length + ' entries',
      function () { enterReader('bhagi'); },
      { whatsNew: bhagiMeta.whatsNew, onEdit: function () { openBookMetaPanel('bhagi', 'BHAGIs'); } }));
  }

  // ---- book metadata (title override + "what's new" blurb) --------------

  var bookMetaPanel = $('bookMetaPanel');
  function openBookMetaPanel(key, fallbackTitle) {
    var meta = effectiveBookMeta(key, fallbackTitle);
    var card = $('bookMetaCard');
    card.innerHTML =
      '<span class="code-badge">' + escapeHtml(fallbackTitle) + '</span>' +
      '<label for="bmTitle">Title</label>' +
      '<input type="text" id="bmTitle" value="' + escapeHtml(meta.title) + '">' +
      '<label for="bmWhatsNew">What’s new message</label>' +
      '<textarea id="bmWhatsNew" style="min-height:80px">' + escapeHtml(meta.whatsNew) + '</textarea>' +
      '<div class="hint">Shown as a short line under this book’s card on the public site. Leave blank to hide it.</div>' +
      '<div class="editor-actions">' +
      '<button class="save" id="bmSaveBtn">Publish change</button>' +
      '<button class="revert" id="bmCancelBtn" type="button">Cancel</button>' +
      (meta.edited ? '<span class="hint" style="margin:0">Edited ' + new Date(state.bookOverrides[key].updatedAt).toLocaleString() + '</span>' : '') +
      '</div>' +
      '<div class="save-msg" id="bmSaveMsg"></div>';
    $('bmCancelBtn').addEventListener('click', closeBookMetaPanel);
    $('bmSaveBtn').addEventListener('click', function () { confirmSaveBookMeta(key, fallbackTitle); });
    if (typeof bookMetaPanel.showModal === 'function') bookMetaPanel.showModal();
    else bookMetaPanel.setAttribute('open', '');
  }

  function closeBookMetaPanel() {
    bookMetaPanel.close ? bookMetaPanel.close() : bookMetaPanel.removeAttribute('open');
  }

  function confirmSaveBookMeta(key, fallbackTitle) {
    // Appended inside the <dialog> (not document.body): once a <dialog> is
    // shown via showModal() it renders in the browser's top layer, above
    // all regular DOM regardless of z-index — an overlay appended to body
    // would be invisible/unclickable behind it.
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>Publish this change?</h3>' +
      '<p>This goes live on the public site immediately — there is no draft or review step to undo it from here (though every change is a normal git commit, so it can always be reverted from GitHub).</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Publish now</button></div>' +
      '</div>';
    bookMetaPanel.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      doSaveBookMeta(key, fallbackTitle);
    });
  }

  function doSaveBookMeta(key, fallbackTitle) {
    var title = $('bmTitle').value.trim() || fallbackTitle;
    var whatsNew = $('bmWhatsNew').value.trim();
    var msg = $('bmSaveMsg');
    var btn = $('bmSaveBtn');
    btn.disabled = true;
    msg.textContent = 'Publishing…';
    msg.className = 'save-msg';

    fetch('/api/save-book-meta', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookKey: key, title: title, whatsNew: whatsNew })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'save failed'); });
      return r.json();
    }).then(function () {
      state.bookOverrides[key] = { title: title, whatsNew: whatsNew, updatedAt: new Date().toISOString() };
      msg.textContent = 'Published — live on the public site now.';
      msg.className = 'save-msg ok';
      btn.disabled = false;
      renderHomeCards();
    }).catch(function (err) {
      msg.textContent = 'Could not publish: ' + err.message;
      msg.className = 'save-msg err';
      btn.disabled = false;
    });
  }

  // ---- guide library uploads ---------------------------------------------

  var UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('could not read that file')); };
      reader.readAsDataURL(file);
    });
  }

  function titleFromFilename(name) {
    return String(name || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();
  }

  var uploadGuidePanel = $('uploadGuidePanel');
  function openUploadGuidePanel() {
    var card = $('uploadGuideCard');
    card.innerHTML =
      '<span class="code-badge">Upload a guide document</span>' +
      '<label for="ugFile">PDF file</label>' +
      '<input type="file" id="ugFile" accept="application/pdf,.pdf">' +
      '<label for="ugTitle">Title</label>' +
      '<input type="text" id="ugTitle" placeholder="e.g. Stallion Sires Guidance 2026">' +
      '<label for="ugCat">Category</label>' +
      '<input type="text" id="ugCat" placeholder="e.g. Breeding (defaults to “Uploaded documents”)">' +
      '<div class="hint">PDFs up to 3MB. Text is extracted as plain paragraphs only — there’s no rule-numbering parser, so it’ll read like a plain document, not a structured chapter like Rules of Racing.</div>' +
      '<div class="editor-actions">' +
      '<button class="save" id="ugSaveBtn">Publish upload</button>' +
      '<button class="revert" id="ugCancelBtn" type="button">Cancel</button>' +
      '</div>' +
      '<div class="save-msg" id="ugSaveMsg"></div>' +
      '<label style="margin-top:20px">Already uploaded</label>' +
      '<div id="ugExistingList" class="uploaded-guide-list"></div>';
    $('ugFile').addEventListener('change', function () {
      var f = $('ugFile').files[0];
      if (f && !$('ugTitle').value.trim()) $('ugTitle').value = titleFromFilename(f.name);
    });
    $('ugCancelBtn').addEventListener('click', closeUploadGuidePanel);
    $('ugSaveBtn').addEventListener('click', confirmUploadGuide);
    renderUploadedGuidesList();
    if (typeof uploadGuidePanel.showModal === 'function') uploadGuidePanel.showModal();
    else uploadGuidePanel.setAttribute('open', '');
  }

  function closeUploadGuidePanel() {
    uploadGuidePanel.close ? uploadGuidePanel.close() : uploadGuidePanel.removeAttribute('open');
  }

  $('uploadGuideBtn').addEventListener('click', openUploadGuidePanel);

  function renderUploadedGuidesList() {
    var list = $('ugExistingList');
    if (!list) return;
    var ids = Object.keys(state.uploadedGuides);
    if (!ids.length) { list.innerHTML = '<div class="hint" style="margin:0">None yet.</div>'; return; }
    list.innerHTML = '';
    ids.forEach(function (id) {
      var u = state.uploadedGuides[id];
      var row = document.createElement('div');
      row.className = 'uploaded-guide-row';
      row.innerHTML = '<span class="title">' + escapeHtml(u.title) + '</span><button type="button">Delete</button>';
      row.querySelector('button').addEventListener('click', function () { confirmDeleteUploadGuide(id); });
      list.appendChild(row);
    });
  }

  function confirmUploadGuide() {
    var fileInput = $('ugFile');
    var title = $('ugTitle').value.trim();
    var cat = $('ugCat').value.trim();
    var msg = $('ugSaveMsg');
    var file = fileInput.files[0];

    if (!file) { msg.textContent = 'Choose a PDF file first.'; msg.className = 'save-msg err'; return; }
    if (!title) { msg.textContent = 'Give it a title first.'; msg.className = 'save-msg err'; return; }
    if (file.size > UPLOAD_MAX_BYTES) { msg.textContent = 'That file is too large — this tool supports PDFs up to 3MB.'; msg.className = 'save-msg err'; return; }
    if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      msg.textContent = 'That doesn’t look like a PDF file.'; msg.className = 'save-msg err'; return;
    }

    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>Publish this upload?</h3>' +
      '<p>This adds a new Guide Library document, live on the public site immediately — there is no draft or review step to undo it from here (though every change is a normal git commit, so it can always be reverted from GitHub).</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Publish now</button></div>' +
      '</div>';
    uploadGuidePanel.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      doUploadGuide(file, title, cat);
    });
  }

  function doUploadGuide(file, title, cat) {
    var msg = $('ugSaveMsg');
    var btn = $('ugSaveBtn');
    btn.disabled = true;
    msg.textContent = 'Uploading and extracting text…';
    msg.className = 'save-msg';

    fileToBase64(file).then(function (base64) {
      return fetch('/api/upload-guide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, title: title, cat: cat, fileBase64: base64 })
      });
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'upload failed'); });
      return r.json();
    }).then(function (j) {
      state.uploadedGuides[j.id] = { title: j.title, cat: j.cat, dated: j.dated, url: j.url, html: j.html, updatedAt: j.updatedAt };
      state.entries.push({
        kind: 'guidedoc', code: null, letter: null, num: null, doc: j.title, title: j.title,
        html: j.html, path: [j.cat], key: j.id, _uploadId: j.id
      });
      msg.textContent = 'Published — live on the public site now.';
      msg.className = 'save-msg ok';
      btn.disabled = false;
      renderUploadedGuidesList();
      renderHomeCards();
    }).catch(function (err) {
      msg.textContent = 'Could not publish: ' + err.message;
      msg.className = 'save-msg err';
      btn.disabled = false;
    });
  }

  function confirmDeleteUploadGuide(id) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>Remove this document?</h3>' +
      '<p>This removes it from the Guide Library on the public site immediately. The uploaded PDF file itself is left in the repo (harmless, and recoverable via git history).</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Remove</button></div>' +
      '</div>';
    uploadGuidePanel.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      doDeleteUploadGuide(id);
    });
  }

  function doDeleteUploadGuide(id) {
    fetch('/api/upload-guide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, delete: true })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'delete failed'); });
      return r.json();
    }).then(function () {
      delete state.uploadedGuides[id];
      state.entries = state.entries.filter(function (e) { return e._uploadId !== id; });
      renderUploadedGuidesList();
      renderHomeCards();
    }).catch(function (err) {
      var msg = $('ugSaveMsg');
      if (msg) { msg.textContent = 'Could not remove: ' + err.message; msg.className = 'save-msg err'; }
    });
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

  function entryMatchesTokens(e, tokens, newOnly) {
    if (newOnly && !effective(e).isNew) return false;
    if (!tokens.length) return true;
    var eff = effective(e);
    var hay = (eff.title + ' ' + e.doc + ' ' + (e.code || '') + ' ' + stripHtml(eff.html)).toLowerCase();
    return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function filterOutlineTree(nodes, tokens, newOnly) {
    var noFilter = !tokens.length && !newOnly;
    var out = [];
    nodes.forEach(function (n) {
      var matchedEntries = n.entries.filter(function (e) { return entryMatchesTokens(e, tokens, newOnly); });
      var filteredChildren = filterOutlineTree(n.children, tokens, newOnly);
      if (noFilter || matchedEntries.length || filteredChildren.length) {
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

  // Consecutive entries sharing one title (BHA's own data often repeats a
  // title across several short rules, e.g. four rules all titled "Scope and
  // application of the Rules") are treated as one editable "section" —
  // matching the granularity BHA's own site edits at, and avoiding a
  // separate identical heading repeated per rule.
  function groupTitleRuns(entries) {
    var groups = [];
    var i = 0;
    while (i < entries.length) {
      var title = entries[i].title;
      var j = i + 1;
      while (j < entries.length && entries[j].title === title) j++;
      groups.push(entries.slice(i, j));
      i = j;
    }
    return groups;
  }

  function dispCodeRange(group) {
    if (group.length === 1) return dispCode(group[0]);
    return dispCode(group[0]) + '–' + dispCode(group[group.length - 1]);
  }

  function renderReaderSection(n, depth) {
    var frag = document.createDocumentFragment();
    var head = document.createElement('div');
    head.id = n.id;
    head.dataset.outlineId = n.id;
    head.dataset.outlineLabel = n.label;
    head.className = 'reader-heading depth-' + depth;
    head.innerHTML = (n.badge ? '<span class="code">' + escapeHtml(n.badge) + '</span>' : '') + escapeHtml(n.label);
    frag.appendChild(head);
    // Re-sort by number before grouping — almost always a no-op (rules.json's
    // own entries already come in numeric order), but a section that's just
    // been renumbered or had a rule added mid-run needs its new arrival
    // placed correctly rather than wherever it landed at the end of
    // state.entries. Non-numbered kinds (codes/guides) compare equal on the
    // 0 fallback, so a stable sort leaves their original order untouched.
    var sortedEntries = n.entries.slice().sort(function (a, b) {
      return (a.num == null ? 0 : a.num) - (b.num == null ? 0 : b.num);
    });
    groupTitleRuns(sortedEntries).forEach(function (group) { frag.appendChild(renderReaderSectionGroup(group)); });
    n.children.forEach(function (c) { frag.appendChild(renderReaderSection(c, depth + 1)); });
    return frag;
  }

  // Reads the flag currently published for this entry (if any) — used so a
  // line edit's save doesn't silently clear an existing New/Updated flag,
  // and vice versa (save-rule.js replaces the whole override record, so
  // every save has to resend whatever it isn't changing).
  function currentFlagOverride(e) {
    var o = e._addedId ? state.addedEntries[e._addedId] : state.overrides[e.key];
    var f = o && o.flag;
    return f === 'not-new' ? 'none' : (f || '');
  }

  // ---- reader: section editing ---------------------------------------
  //
  // Editing happens one "section" at a time — a run of consecutive entries
  // sharing one title (see groupTitleRuns), matching the granularity BHA's
  // own PDF edits at. A pencil on the section's shared header (only shown
  // once "Edit" is toggled on, and only on hovering the header row) opens
  // the whole section — title, every rule's text, and its sub-clauses — in
  // the reader's shared right-hand editor. Rules can be reordered, added or
  // removed there; doing so renumbers the section sequentially from
  // whatever number it started at (with an explicit warning before
  // publishing, since other rules/penalty tables may cite the old numbers).
  // A rule with no BHA original (freshly added, or a previously-renumbered
  // one) is edited the same way, via addedEntries — see api/save-rule.js.
  //
  // Per-line New/Updated tagging (the data-flag attribute that groups
  // consecutive flagged lines under one pill — see flagGroupStart) is
  // preserved verbatim through the round trip but isn't editable from this
  // panel; that's the highlight-to-tag popup, still to come.

  function makePencilBtn(title) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'edit-line-pencil';
    btn.title = title;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z"></path></svg>';
    return btn;
  }

  function flagGroupStart(flag) {
    var group = document.createElement('div');
    group.className = 'flagged-group ' + flag;
    var tag = document.createElement('div');
    tag.className = 'flagged-group-tag';
    tag.innerHTML = '<span class="pill-' + flag + '">' + (flag === 'new' ? 'New' : 'Updated') + '</span>';
    group.appendChild(tag);
    return group;
  }

  // Shared confirm step for every publish from the reader's right-hand
  // editor — goes live immediately, so this is the one pause before that
  // happens.
  function confirmPublish(question, onConfirm) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>' + escapeHtml(question) + '</h3>' +
      '<p>This goes live on the public site immediately — there is no draft or review step to undo it from here (though every change is a normal git commit, so it can always be reverted from GitHub).</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Publish now</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      onConfirm();
    });
  }

  // The reader's shared right-hand editor — one at a time, so opening a
  // different section's pencil simply replaces whatever was open rather
  // than letting several edits pile up inline through the document.
  function readerEditorPane() { return $('readerEditorSlot'); }
  function clearReaderEditor() { readerEditorPane().innerHTML = ''; }

  // Renders a group's body (read mode only — the section editor is the only
  // way to *open* an edit, though the highlight-to-tag popup below tags a
  // flag straight from here too), grouping consecutive same-flagged lines
  // under one pill, exactly as the public site's own groupFlaggedLines
  // does. Each rendered line is stamped with the entry it came from and its
  // own 0-based position within that entry (data-entry-key/data-line-index)
  // — a section can span several original entries, so a highlight-to-tag
  // selection needs to know which entry's html to patch and which of that
  // entry's lines it actually touched.
  function renderGroupBody(container, entries) {
    container.innerHTML = '';
    var flagGroup = null, groupFlag = null, any = false;
    entries.forEach(function (e) {
      var tmp = document.createElement('div');
      tmp.innerHTML = effective(e).html;
      var lineIdx = 0;
      Array.prototype.forEach.call(Array.prototype.slice.call(tmp.children), function (el) {
        any = true;
        if (el.tagName !== 'P') { flagGroup = null; groupFlag = null; container.appendChild(el); return; }
        el.dataset.entryKey = e.key;
        el.dataset.lineIndex = lineIdx++;
        var flag = el.getAttribute('data-flag') || '';
        var target;
        if (flag && flag === groupFlag) {
          target = flagGroup;
        } else {
          flagGroup = flag ? flagGroupStart(flag) : null;
          groupFlag = flag;
          if (flagGroup) container.appendChild(flagGroup);
          target = flagGroup || container;
        }
        target.appendChild(el);
      });
    });
    if (!any) container.innerHTML = entries.map(function (e) { return effective(e).html; }).join('');
  }

  function renderReaderSectionGroup(group) {
    var block = document.createElement('div');
    block.className = 'reader-entry' + (group.some(function (e) { return e.key === state.selectedKey; }) ? ' selected' : '');
    block.dataset.key = group[0].key;
    var anyNew = group.some(function (e) { return effective(e).isNew; });
    var anyUpdated = !anyNew && group.some(function (e) { return effective(e).isUpdated; });
    var editedEntries = group.filter(function (e) { return effective(e).edited; });
    var titleHtml = '<span class="reader-entry-title">' + escapeHtml(group[0].title) + '</span>';
    block.innerHTML = '<div class="reader-entry-head' + (state.readerEditMode ? ' editable' : '') + '">' +
      '<span class="' + codeClass(group[0]) + '">' + escapeHtml(dispCodeRange(group)) + '</span>' +
      titleHtml +
      (anyNew ? '<span class="pill-new">New</span>' : anyUpdated ? '<span class="pill-updated">Updated</span>' : '') +
      (editedEntries.length ? '<span class="edited-dot" title="Has a published edit"></span>' : '') +
      (editedEntries.length && state.readerEditMode ? '<button type="button" class="discard-edit-btn">Discard edit</button>' : '') +
      (state.readerEditMode ? makePencilBtn('Edit this section').outerHTML : '') +
      '</div>' +
      '<div class="rfull-body"></div>';
    renderGroupBody(block.querySelector('.rfull-body'), group);
    var pencil = block.querySelector('.reader-entry-head > .edit-line-pencil');
    if (pencil) pencil.addEventListener('click', function () { openSectionEditor(group, block); });
    var discardBtn = block.querySelector('.discard-edit-btn');
    if (discardBtn) discardBtn.addEventListener('click', function () { confirmDiscardEdit(editedEntries); });
    return block;
  }

  // ---- section editor --------------------------------------------------

  function extractLineText(el) {
    var clone = el.cloneNode(true);
    var rn = clone.querySelector(':scope > .rn');
    if (rn) rn.parentNode.removeChild(rn);
    return { className: el.className || '', flag: el.getAttribute('data-flag') || '', text: stripHtml(clone.innerHTML) };
  }

  // Splits one entry's html into its lead line, its numbered sub-clauses
  // and anything else (tables etc, kept verbatim and re-appended unedited).
  // `numbered` records whether this entry ever had a real rule number at
  // all — codes/guides don't, and must never have one synthesised for them.
  function parseEntryRows(e) {
    var eff = effective(e);
    var tmp = document.createElement('div');
    tmp.innerHTML = eff.html;
    var lead = null, subs = [], otherHtml = '';
    Array.prototype.forEach.call(tmp.children, function (el) {
      if (el.tagName === 'P') {
        if (!lead) lead = extractLineText(el); else subs.push(extractLineText(el));
      } else {
        otherHtml += el.outerHTML;
      }
    });
    if (!lead) lead = { className: 'l1', flag: '', text: '' };
    return {
      key: e.key, _addedId: e._addedId, numbered: e.num != null,
      num: e.num, letter: e.letter, doc: e.doc, path: e.path,
      flag: currentFlagOverride(e), lead: lead, subs: subs, otherHtml: otherHtml
    };
  }

  function buildLineHtml(tag, className, flag, text, numLabel) {
    var clsAttr = className ? ' class="' + className + '"' : '';
    var flagAttr = flag ? ' data-flag="' + flag + '"' : '';
    var rnHtml = numLabel ? '<span class="rn">' + escapeHtml(numLabel) + '</span>' : '';
    var bodyHtml = escapeHtmlAllowInline(text).replace(/\n/g, '<br>');
    return '<' + tag + clsAttr + flagAttr + '>' + rnHtml + bodyHtml + '</' + tag + '>';
  }

  function buildEntryHtml(row, newNum) {
    var leadNum = row.numbered ? String(newNum) : '';
    var html = buildLineHtml('p', row.lead.className || 'l1', row.lead.flag, row.lead.text, leadNum);
    row.subs.forEach(function (sub, i) {
      var subNum = row.numbered ? (newNum + '.' + (i + 1)) : '';
      html += buildLineHtml('p', sub.className || 'l2', sub.flag, sub.text, subNum);
    });
    html += row.otherHtml || '';
    return html;
  }

  var RICH_CMDS = ['b', 'i', 'u', 'sub', 'sup'];
  var RICH_LABELS = { b: '<b>B</b>', i: '<i>I</i>', u: '<u>U</u>', sub: 'X<sub>2</sub>', sup: 'X<sup>2</sup>' };
  var RICH_TITLES = { b: 'Bold', i: 'Italic', u: 'Underline', sub: 'Subscript', sup: 'Superscript' };
  var SECTION_ICONS = {
    up: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"></path></svg>',
    down: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"></path></svg>',
    trash: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8.4a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.4"></path></svg>'
  };

  // Bare buttons (no wrapping toolbar div) — the caller drops them into a
  // shared .toolbar-group alongside whatever move/flag controls that row
  // also has, so the whole thing reads as one tidy icon bar rather than a
  // stack of differently-styled control rows.
  function renderRichToolbarHtml() {
    return RICH_CMDS.map(function (cmd) {
      return '<button type="button" class="section-tool-btn rich-btn" data-cmd="' + cmd + '" title="' + RICH_TITLES[cmd] + '">' + RICH_LABELS[cmd] + '</button>';
    }).join('');
  }

  // Wraps (or, on a second click over the same span, unwraps) the
  // textarea's current selection in a literal <tag>...</tag> — the same
  // inline tags stripHtml/escapeHtmlAllowInline know to preserve.
  function wrapSelectionTag(textarea, tag) {
    var start = textarea.selectionStart, end = textarea.selectionEnd;
    var val = textarea.value;
    var selected = val.slice(start, end);
    var openTag = '<' + tag + '>', closeTag = '</' + tag + '>';
    var already = selected.slice(0, openTag.length) === openTag && selected.slice(-closeTag.length) === closeTag;
    var replacement = already ? selected.slice(openTag.length, selected.length - closeTag.length) : openTag + selected + closeTag;
    textarea.value = val.slice(0, start) + replacement + val.slice(end);
    textarea.focus();
    var selEnd = start + replacement.length;
    textarea.setSelectionRange(already ? selEnd : start + openTag.length, already ? selEnd : start + openTag.length + selected.length);
  }

  function wireRichToolbar(scopeEl, textarea) {
    Array.prototype.forEach.call(scopeEl.querySelectorAll('.rich-btn'), function (btn) {
      btn.addEventListener('click', function () { wrapSelectionTag(textarea, btn.dataset.cmd); });
    });
  }

  function openSectionEditor(group, block) {
    state._sectionEditGroup = group;
    state._sectionEditBlock = block;
    state._sectionEditTitle = group[0].title;
    state._sectionEditNumbered = group.every(function (e) { return e.num != null; });
    state._sectionEditRows = group.map(parseEntryRows);
    renderSectionEditor();
  }

  // Reads whatever's currently typed back into state._sectionEditRows —
  // called before any structural change (add/remove/reorder a rule or
  // sub-clause) or before save, so in-progress typing survives a re-render.
  function syncSectionEditRowsFromDom() {
    var rulesEl = $('secRules');
    if (!rulesEl) return;
    var rows = state._sectionEditRows;
    Array.prototype.forEach.call(rulesEl.children, function (rowEl) {
      var row = rows[Number(rowEl.dataset.rowIndex)];
      if (!row) return;
      var leadTa = rowEl.querySelector(':scope > .section-rule-lead');
      if (leadTa) row.lead.text = leadTa.value;
      var subsEl = rowEl.querySelector(':scope > .section-subs');
      if (subsEl) {
        Array.prototype.forEach.call(subsEl.children, function (subEl) {
          var sub = row.subs[Number(subEl.dataset.subIndex)];
          var ta = subEl.querySelector('.section-sub-textarea');
          if (sub && ta) sub.text = ta.value;
        });
      }
    });
    var titleInput = $('secTitleInput');
    if (titleInput) state._sectionEditTitle = titleInput.value;
  }

  function renderSectionSubRow(row, sub, j) {
    var wrap = document.createElement('div');
    wrap.className = 'section-sub-row';
    wrap.dataset.subIndex = j;
    wrap.innerHTML =
      '<div class="section-sub-toolbar">' +
      '<div class="toolbar-group">' + renderRichToolbarHtml() + '</div>' +
      '<button type="button" class="section-tool-btn danger section-sub-remove" title="Remove this sub-clause">' + SECTION_ICONS.trash + '</button>' +
      '</div>' +
      '<textarea class="section-sub-textarea"></textarea>';
    wrap.querySelector('.section-sub-textarea').value = sub.text;
    wireRichToolbar(wrap.querySelector('.section-sub-toolbar'), wrap.querySelector('.section-sub-textarea'));
    wrap.querySelector('.section-sub-remove').addEventListener('click', function () {
      syncSectionEditRowsFromDom();
      row.subs.splice(j, 1);
      renderSectionEditor();
    });
    return wrap;
  }

  function renderSectionRuleRow(row, i, total) {
    var wrap = document.createElement('div');
    wrap.className = 'section-rule-row';
    wrap.dataset.rowIndex = i;
    var numbered = state._sectionEditNumbered;
    var badge = row.key ? dispCode({ code: row.key, _addedId: row._addedId, letter: row.letter, num: row.num }) : 'New rule';
    wrap.innerHTML =
      '<div class="section-rule-top">' +
      '<span class="section-rule-num">' + escapeHtml(badge) + '</span>' +
      (numbered && total > 1 ? '<button type="button" class="section-tool-btn danger section-rule-remove" title="Remove this rule">' + SECTION_ICONS.trash + '</button>' : '') +
      '</div>' +
      '<div class="section-rule-toolbar">' +
      (numbered ?
        '<div class="toolbar-group">' +
        '<button type="button" class="section-tool-btn sec-up" title="Move up"' + (i === 0 ? ' disabled' : '') + '>' + SECTION_ICONS.up + '</button>' +
        '<button type="button" class="section-tool-btn sec-down" title="Move down"' + (i === total - 1 ? ' disabled' : '') + '>' + SECTION_ICONS.down + '</button>' +
        '</div>' : '') +
      '<div class="toolbar-group">' + renderRichToolbarHtml() + '</div>' +
      '<div class="toolbar-group">' +
      '<button type="button" class="section-tool-btn flag-toggle sec-flag-new" title="Mark this rule New">New</button>' +
      '<button type="button" class="section-tool-btn flag-toggle sec-flag-updated" title="Mark this rule Updated">Updated</button>' +
      '</div>' +
      '</div>' +
      '<textarea class="section-rule-lead"></textarea>' +
      '<div class="section-subs"></div>' +
      '<button type="button" class="section-add-sub">+ Add sub-clause</button>';
    wrap.querySelector('.section-rule-lead').value = row.lead.text;
    wireRichToolbar(wrap.querySelector('.section-rule-toolbar'), wrap.querySelector('.section-rule-lead'));

    var subsEl = wrap.querySelector('.section-subs');
    row.subs.forEach(function (sub, j) { subsEl.appendChild(renderSectionSubRow(row, sub, j)); });

    var flagNewBtn = wrap.querySelector('.sec-flag-new'), flagUpdatedBtn = wrap.querySelector('.sec-flag-updated');
    function syncFlagUI() {
      flagNewBtn.classList.toggle('active', row.flag === 'new');
      flagUpdatedBtn.classList.toggle('active', row.flag === 'updated');
    }
    syncFlagUI();
    flagNewBtn.addEventListener('click', function () { row.flag = row.flag === 'new' ? '' : 'new'; syncFlagUI(); });
    flagUpdatedBtn.addEventListener('click', function () { row.flag = row.flag === 'updated' ? '' : 'updated'; syncFlagUI(); });

    var upBtn = wrap.querySelector('.sec-up'), downBtn = wrap.querySelector('.sec-down');
    if (upBtn) upBtn.addEventListener('click', function () {
      syncSectionEditRowsFromDom();
      var rows = state._sectionEditRows;
      var tmp = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = tmp;
      renderSectionEditor();
    });
    if (downBtn) downBtn.addEventListener('click', function () {
      syncSectionEditRowsFromDom();
      var rows = state._sectionEditRows;
      var tmp = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = tmp;
      renderSectionEditor();
    });
    var removeBtn = wrap.querySelector('.section-rule-remove');
    if (removeBtn) removeBtn.addEventListener('click', function () {
      syncSectionEditRowsFromDom();
      state._sectionEditRows.splice(i, 1);
      renderSectionEditor();
    });
    wrap.querySelector('.section-add-sub').addEventListener('click', function () {
      syncSectionEditRowsFromDom();
      row.subs.push({ className: 'l2', flag: '', text: '' });
      renderSectionEditor();
    });
    return wrap;
  }

  function renderSectionEditor() {
    var group = state._sectionEditGroup;
    var rows = state._sectionEditRows;
    var numbered = state._sectionEditNumbered;
    var pane = readerEditorPane();
    var card = document.createElement('div');
    card.className = 'editor-card section-editor-card';
    card.innerHTML =
      '<span class="code-badge">' + escapeHtml(dispCodeRange(group)) + ' — section</span>' +
      '<label for="secTitleInput">Title</label>' +
      '<input type="text" id="secTitleInput" value="' + escapeHtml(state._sectionEditTitle) + '">' +
      '<div class="section-rules" id="secRules"></div>' +
      (numbered ? '<button type="button" class="section-add-rule" id="secAddRule">+ Add rule</button>' : '') +
      '<div class="hint">' + (numbered
        ? 'Adding, removing or reordering rules renumbers this section when you publish — anything citing the old numbers (other rules, penalty tables) will be out of date.'
        : 'This document type isn’t numbered, so rules can’t be added, removed or reordered here — only their text and title.') + '</div>' +
      '<div class="editor-actions">' +
      '<button class="save" id="secSaveBtn">Publish section</button>' +
      '<button class="revert" id="secCancelBtn" type="button">Cancel</button>' +
      '</div>' +
      '<div class="save-msg" id="secSaveMsg"></div>';
    pane.innerHTML = '';
    pane.appendChild(card);
    var rulesEl = $('secRules');
    rows.forEach(function (row, i) { rulesEl.appendChild(renderSectionRuleRow(row, i, rows.length)); });
    var titleInput = $('secTitleInput');
    titleInput.addEventListener('input', function () { state._sectionEditTitle = titleInput.value; });
    if (numbered) {
      $('secAddRule').addEventListener('click', function () {
        syncSectionEditRowsFromDom();
        rows.push({
          key: null, _addedId: null, numbered: true, num: null,
          letter: group[0].letter, doc: group[0].doc, path: group[0].path,
          flag: '', lead: { className: 'l1', flag: '', text: '' }, subs: [], otherHtml: ''
        });
        renderSectionEditor();
        var leads = rulesEl.querySelectorAll('.section-rule-lead');
        if (leads.length) leads[leads.length - 1].focus();
      });
    }
    $('secCancelBtn').addEventListener('click', function () {
      state._sectionEditGroup = null; state._sectionEditRows = null; state._sectionEditBlock = null;
      clearReaderEditor();
    });
    $('secSaveBtn').addEventListener('click', function () {
      syncSectionEditRowsFromDom();
      confirmSectionSave();
    });
  }

  function confirmSectionSave() {
    var rows = state._sectionEditRows;
    if (!rows.length) { alert('A section needs at least one rule.'); return; }
    if (rows.some(function (r) { return !r.lead.text.trim(); })) { alert('Every rule needs some text.'); return; }
    var title = (state._sectionEditTitle || '').trim();
    if (!title) { alert('Give this section a title.'); return; }
    var group = state._sectionEditGroup;
    var needsRenumber = state._sectionEditNumbered &&
      (rows.length !== group.length || rows.some(function (r, i) { return r.key !== group[i].key; }));
    if (needsRenumber) {
      var overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML =
        '<div class="confirm-box">' +
        '<h3>Renumber this section?</h3>' +
        '<p>Adding, removing or reordering rules here renumbers everything in this section from ' + escapeHtml(dispCode(group[0])) + ' — live immediately. Anything citing the old numbers — other rules, penalty tables, external references — will be out of date.</p>' +
        '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Renumber and publish</button></div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
      overlay.querySelector('.confirm').addEventListener('click', function () { overlay.remove(); doSaveSection(title); });
    } else {
      confirmPublish('Publish this section?', function () { doSaveSection(title); });
    }
  }

  function applyRemoveEntry(key) {
    state.entries = state.entries.filter(function (x) { return x.key !== key; });
    delete state.overrides[key];
    if (state.addedEntries[key]) delete state.addedEntries[key];
    else state.deletedEntries[key] = true;
  }

  function applyAddEntry(resp, row, newNum, title, html) {
    var id = resp.id;
    state.addedEntries[id] = {
      letter: row.letter, num: newNum, doc: row.doc, title: title, html: html, path: row.path || [],
      flag: row.flag || undefined, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    state.entries.push({
      kind: 'manual', code: id, letter: row.letter, num: newNum, doc: row.doc,
      title: title, html: html, path: row.path || [], isNew: false, _addedId: id, key: id
    });
  }

  // Every add/remove/update needed to publish the section is its own
  // /api/save-rule call (the GitHub Contents API needs the latest sha per
  // write), run one at a time — each carries its own local-state patch so
  // the reader can be redrawn in place afterwards without a full reload
  // (which would otherwise knock the admin out of the book being edited).
  function doSaveSection(title) {
    var rows = state._sectionEditRows;
    var group = state._sectionEditGroup;
    var numbered = state._sectionEditNumbered;
    var startNum = group[0].num;
    var actions = [];
    var keptKeys = {};

    rows.forEach(function (row, i) {
      var newNum = numbered ? startNum + i : row.num;
      var html = buildEntryHtml(row, newNum);
      if (row.key && row.num === newNum) {
        keptKeys[row.key] = true;
        actions.push({
          request: { key: row.key, title: title, html: html, flag: row.flag || 'none' },
          apply: function () {
            if (row._addedId) {
              state.addedEntries[row.key] = Object.assign({}, state.addedEntries[row.key], { title: title, html: html, flag: row.flag || undefined, updatedAt: new Date().toISOString() });
            } else {
              state.overrides[row.key] = Object.assign({}, state.overrides[row.key], { title: title, html: html, flag: row.flag || 'none', updatedAt: new Date().toISOString() });
            }
            state.entries.forEach(function (x) { if (x.key === row.key) { x.title = title; x.html = html; } });
          }
        });
      } else if (row.key) {
        keptKeys[row.key] = true;
        var oldKey = row.key;
        actions.push({ request: { removeEntry: oldKey }, apply: function () { applyRemoveEntry(oldKey); } });
        actions.push({
          request: { addEntry: { letter: row.letter, num: newNum, doc: row.doc, title: title, html: html, path: row.path, flag: row.flag || undefined } },
          apply: function (resp) { applyAddEntry(resp, row, newNum, title, html); }
        });
      } else {
        actions.push({
          request: { addEntry: { letter: row.letter, num: newNum, doc: row.doc, title: title, html: html, path: row.path, flag: row.flag || undefined } },
          apply: function (resp) { applyAddEntry(resp, row, newNum, title, html); }
        });
      }
    });

    group.forEach(function (e) {
      if (!keptKeys[e.key]) {
        var key = e.key;
        actions.push({ request: { removeEntry: key }, apply: function () { applyRemoveEntry(key); } });
      }
    });

    var btn = $('secSaveBtn'), msg = $('secSaveMsg');
    btn.disabled = true;
    msg.textContent = 'Publishing…';
    msg.className = 'save-msg';
    runSectionActions(actions, msg, btn);
  }

  function runSectionActions(actions, msg, btn) {
    if (!actions.length) {
      clearReaderEditor();
      refreshReaderAfterSectionSave();
      return;
    }
    var action = actions.shift();
    if (actions.length) msg.textContent = 'Publishing… (' + actions.length + ' step' + (actions.length === 1 ? '' : 's') + ' left)';
    fetch('/api/save-rule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action.request)
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'save failed'); });
      return r.json();
    }).then(function (resp) {
      action.apply(resp);
      runSectionActions(actions, msg, btn);
    }).catch(function (err) {
      msg.textContent = 'Could not publish: ' + err.message;
      msg.className = 'save-msg err';
      btn.disabled = false;
    });
  }

  // Rebuilds just the current book's outline tree from the now-patched
  // state.entries and redraws the reader body — everything a section save
  // can change (text, numbers, which entries exist) without resetting
  // search text, edit mode, or navigating away from the book being edited.
  function refreshReaderAfterSectionSave() {
    var book = state.readerBook;
    var pool = book === 'guides' ? state.entries.filter(isGuideEntry)
      : book === 'bhagi' ? state.entries.filter(function (e) { return e.kind === 'bhagi'; })
      : state.entries.filter(function (e) { return !isGuideEntry(e); });
    state.readerTree = (book === 'guides' || book === 'bhagi') ? buildGuidesOutline(pool) : buildRulesOutline(state.manuals, pool);
    renderReaderBody($('readerSearch') ? $('readerSearch').value : '');
  }

  // ---- highlight-to-tag popup ------------------------------------------
  //
  // Selecting some rendered text in edit mode (a plain mouse drag over the
  // section body, no editor open) pops up a small New/Updated/Clear control
  // right next to it — Word/Google-Docs style — rather than opening the
  // section editor just to flag a line. The selection snaps to every whole
  // line it touches (matching the sub-clause level flagging already worked
  // this way), using the data-entry-key/data-line-index each rendered <p>
  // carries (see renderGroupBody) to know which entry's html to patch and
  // exactly which of its lines to flag. Intentionally no confirm dialog —
  // the whole point is a fast, low-friction tag that's just as fast to
  // undo (select the same text, hit Clear).

  function closestFlaggableLine(node) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    return el ? el.closest('p[data-entry-key]') : null;
  }

  function linesBetween(body, startP, endP) {
    var all = Array.prototype.slice.call(body.querySelectorAll('p[data-entry-key]'));
    var i1 = all.indexOf(startP), i2 = all.indexOf(endP);
    if (i1 === -1 || i2 === -1) return [];
    return all.slice(Math.min(i1, i2), Math.max(i1, i2) + 1);
  }

  var lineFlagPopupEl = null;
  function hideLineFlagPopup() {
    if (lineFlagPopupEl) { lineFlagPopupEl.remove(); lineFlagPopupEl = null; }
  }

  function showLineFlagPopup(lines, rect) {
    hideLineFlagPopup();
    var popup = document.createElement('div');
    popup.className = 'line-flag-popup';
    popup.innerHTML =
      '<button type="button" data-flag="new">New</button>' +
      '<button type="button" data-flag="updated">Updated</button>' +
      '<button type="button" data-flag="">Clear</button>';
    document.body.appendChild(popup);
    var top = rect.top + window.scrollY - popup.offsetHeight - 8;
    var left = rect.left + window.scrollX + rect.width / 2 - popup.offsetWidth / 2;
    popup.style.top = Math.max(8, top) + 'px';
    popup.style.left = Math.max(8, left) + 'px';
    lineFlagPopupEl = popup;
    Array.prototype.forEach.call(popup.querySelectorAll('button'), function (btn) {
      btn.addEventListener('click', function () {
        applyLineFlag(lines, btn.dataset.flag);
        hideLineFlagPopup();
        window.getSelection().removeAllRanges();
      });
    });
  }

  document.addEventListener('mouseup', function () {
    if (!state.readerEditMode) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideLineFlagPopup(); return; }
    var range = sel.getRangeAt(0);
    var startP = closestFlaggableLine(range.startContainer);
    var endP = closestFlaggableLine(range.endContainer);
    if (!startP || !endP) { hideLineFlagPopup(); return; }
    var body = startP.closest('.rfull-body');
    if (!body || body !== endP.closest('.rfull-body')) { hideLineFlagPopup(); return; }
    var lines = linesBetween(body, startP, endP);
    if (!lines.length) { hideLineFlagPopup(); return; }
    showLineFlagPopup(lines, range.getBoundingClientRect());
  });
  document.addEventListener('mousedown', function (ev) {
    if (lineFlagPopupEl && !lineFlagPopupEl.contains(ev.target)) hideLineFlagPopup();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') hideLineFlagPopup();
  });

  // Patches just the touched lines' data-flag inside each affected entry's
  // own html (re-parsed fresh from its current published html, not the
  // live decorated DOM) and republishes each entry that changed.
  function applyLineFlag(lines, flag) {
    var byEntry = {};
    lines.forEach(function (p) {
      var key = p.dataset.entryKey;
      (byEntry[key] || (byEntry[key] = [])).push(Number(p.dataset.lineIndex));
    });
    var actions = Object.keys(byEntry).map(function (key) {
      var entry = null;
      state.entries.forEach(function (x) { if (x.key === key) entry = x; });
      if (!entry) return null;
      var idxSet = byEntry[key];
      var tmp = document.createElement('div');
      tmp.innerHTML = effective(entry).html;
      var i = 0;
      Array.prototype.forEach.call(Array.prototype.slice.call(tmp.children), function (el) {
        if (el.tagName !== 'P') return;
        if (idxSet.indexOf(i) !== -1) {
          if (flag) el.setAttribute('data-flag', flag); else el.removeAttribute('data-flag');
        }
        i++;
      });
      return { key: key, html: tmp.innerHTML, entry: entry };
    }).filter(Boolean);
    runLineFlagActions(actions);
  }

  function runLineFlagActions(actions) {
    if (!actions.length) { refreshReaderAfterSectionSave(); return; }
    var action = actions.shift();
    fetch('/api/save-rule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: action.key, html: action.html, flag: currentFlagOverride(action.entry) })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'save failed'); });
      return r.json();
    }).then(function () {
      if (action.entry._addedId) {
        state.addedEntries[action.key] = Object.assign({}, state.addedEntries[action.key], { html: action.html, updatedAt: new Date().toISOString() });
      } else {
        state.overrides[action.key] = Object.assign({}, state.overrides[action.key], { html: action.html, updatedAt: new Date().toISOString() });
      }
      state.entries.forEach(function (x) { if (x.key === action.key) x.html = action.html; });
      runLineFlagActions(actions);
    }).catch(function (err) {
      alert('Could not publish: ' + err.message);
    });
  }

  function toggleReaderEditMode() {
    state.readerEditMode = !state.readerEditMode;
    if ($('readerEditToggle')) {
      $('readerEditToggle').textContent = state.readerEditMode ? 'Done editing' : 'Edit';
      $('readerEditToggle').classList.toggle('active', state.readerEditMode);
    }
    if ($('readerEditorSlot')) clearReaderEditor();
    renderReaderBody($('readerSearch') ? $('readerSearch').value : '');
  }
  if ($('readerEditToggle')) $('readerEditToggle').addEventListener('click', toggleReaderEditMode);

  // Desktop gives the outline / content / editor columns their own scroll
  // instead of the page's (see the min-width:981px block in admin.css), so
  // the scroll-spy has to watch whichever pane actually has the overflow
  // and measure headings relative to IT. Below that breakpoint the page
  // scrolls as a whole and window-scroll still covers it, same as before.
  var readerScrollHandler = null, readerScrollTarget = null;
  function teardownScrollSpy() {
    if (readerScrollHandler && readerScrollTarget) readerScrollTarget.removeEventListener('scroll', readerScrollHandler);
    readerScrollHandler = null;
    readerScrollTarget = null;
  }
  function setupScrollSpy(entriesEl) {
    teardownScrollSpy();
    var pane = entriesEl.parentElement; // .reader-content on desktop
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
      var crumbSection = $('readerCrumbSection');
      if (crumbSection) crumbSection.textContent = activeTopHeading ? activeTopHeading.dataset.outlineLabel : '';
    }
    readerScrollHandler = function () { if (ticking) return; ticking = true; window.requestAnimationFrame(update); };
    readerScrollTarget = target;
    target.addEventListener('scroll', readerScrollHandler, { passive: true });
    update();
  }

  function syncReaderChromeOffsets() {
    var headerEl = document.querySelector('header'), backEl = $('readerBack');
    var headerH = headerEl ? headerEl.offsetHeight : 49;
    var backH = backEl ? backEl.offsetHeight : 0;
    var root = document.documentElement.style;
    root.setProperty('--rd-header-h', headerH + 'px');
    root.setProperty('--rd-backrow-h', backH + 'px');
  }
  window.addEventListener('resize', function () {
    if (state.manualsView === 'reader') syncReaderChromeOffsets();
  });

  // Belt-and-braces against the outer page moving at all in desktop reader
  // mode: an el.scrollIntoView() call (outline links etc.) can still
  // cascade up and nudge document.documentElement.scrollTop directly even
  // though html/body have overflow:hidden there — which shifts the fixed
  // breadcrumb row up behind the fixed header, looking like it vanished.
  // Snapping straight back to 0 neutralises that regardless of the cause.
  var desktopReaderMQ = window.matchMedia('(min-width: 981px)');
  window.addEventListener('scroll', function () {
    if (state.manualsView === 'reader' && desktopReaderMQ.matches && window.scrollY !== 0) window.scrollTo(0, 0);
  }, { passive: true });

  function renderReaderBody(rawQuery) {
    var tokens = rawQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var newOnly = !!state.readerNewOnly;
    var filtering = tokens.length || newOnly;
    var filtered = filterOutlineTree(state.readerTree, tokens, newOnly);

    var navList = $('readerOutlineList');
    navList.innerHTML = '';
    navList.appendChild(renderOutlineNav(filtered, 0));

    var entriesEl = $('readerEntries');
    entriesEl.innerHTML = '';
    var countEl = $('readerCount');
    if (filtering) {
      var n = countOutlineEntries(filtered);
      countEl.textContent = n + (n === 1 ? ' match' : ' matches');
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
    if (filtering && !filtered.length) {
      entriesEl.innerHTML = '<div class="empty-state">' + (newOnly && !tokens.length ? 'Nothing flagged new right now.' : 'Nothing matches that.') + '</div>';
    } else {
      filtered.forEach(function (n) { entriesEl.appendChild(renderReaderSection(n, 0)); });
    }
    teardownScrollSpy();
    if (!filtering) setupScrollSpy(entriesEl);
  }

  function renderReader() {
    var book = state.readerBook;
    var titleText = book === 'guides' ? 'Guide Library' : book === 'bhagi' ? 'BHAGIs' : 'Rules of Racing';
    $('readerTitle').textContent = titleText;
    $('readerCrumbBook').textContent = titleText;
    $('readerCrumbSection').textContent = '';

    var pool = book === 'guides' ? state.entries.filter(isGuideEntry)
      : book === 'bhagi' ? state.entries.filter(function (e) { return e.kind === 'bhagi'; })
      : state.entries.filter(function (e) { return !isGuideEntry(e); });

    state.readerTree = (book === 'guides' || book === 'bhagi')
      ? buildGuidesOutline(pool)
      : buildRulesOutline(state.manuals, pool);

    $('readerSearch').value = '';
    state.readerNewOnly = false;
    if ($('readerNewOnly')) $('readerNewOnly').checked = false;
    state.readerEditMode = false;
    if ($('readerEditToggle')) { $('readerEditToggle').textContent = 'Edit'; $('readerEditToggle').classList.remove('active'); }
    if ($('readerEditorSlot')) clearReaderEditor();
    renderReaderBody('');
  }

  function enterReader(book) {
    state.manualsView = 'reader';
    state.readerBook = book;
    state.selectedKey = null;
    renderManualsView();
    syncReaderChromeOffsets();
    renderReader();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Jumping to an entry from the flat search/list view used to open its own
  // whole-entry textarea editor, which flattened numbered sub-clauses to
  // plain paragraphs and lost the structure. All editing now goes through
  // the reader's per-line editor instead, which preserves each line's real
  // numbering — so a result row jumps straight into the reader, scrolled to
  // and with Edit already on, rather than opening its own panel.
  function enterReaderAtEntry(e) {
    var book = e.kind === 'bhagi' ? 'bhagi' : isGuideEntry(e) ? 'guides' : 'rules';
    enterReader(book);
    state.selectedKey = e.key;
    state.readerEditMode = true;
    if ($('readerEditToggle')) {
      $('readerEditToggle').textContent = 'Done editing';
      $('readerEditToggle').classList.add('active');
    }
    renderReaderBody('');
    var target = document.querySelector('.reader-entry[data-key="' + CSS.escape(e.key) + '"]');
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  $('readerCrumbHome').addEventListener('click', function () {
    teardownScrollSpy();
    updateManualsViewFromFilters();
  });
  $('readerCrumbBook').addEventListener('click', function () {
    $('readerScroll').scrollTo({ top: 0, behavior: 'smooth' });
  });

  var readerSearchDebounce = null;
  $('readerSearch').addEventListener('input', function () {
    clearTimeout(readerSearchDebounce);
    var val = this.value;
    readerSearchDebounce = setTimeout(function () { renderReaderBody(val); }, 80);
  });
  if ($('readerNewOnly')) $('readerNewOnly').addEventListener('change', function () {
    state.readerNewOnly = this.checked;
    renderReaderBody($('readerSearch').value);
  });

  $('backToTop').addEventListener('click', function () { $('readerScroll').scrollTo({ top: 0, behavior: 'smooth' }); });
  $('readerScroll').addEventListener('scroll', function () {
    $('backToTop').classList.toggle('show', $('readerScroll').scrollTop > 300);
  }, { passive: true });

  function matchesTab(e) {
    if (state.tab === 'new') return effective(e).isNew;
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
      row.innerHTML = '<span class="' + codeClass(e) + '">' + escapeHtml(dispCode(e)) + '</span>' +
        '<span class="title">' + escapeHtml(eff.title) + '</span>' +
        (eff.edited ? '<span class="edited-dot" title="Has a published edit"></span>' : '') +
        '<span class="doc">' + escapeHtml(e.doc) + '</span>';
      row.addEventListener('click', function () { enterReaderAtEntry(e); });
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  // ---- discard edit (reader) ---------------------------------------------
  //
  // Reverts an entry's override entirely, back to BHA's own published text
  // — the one thing the old whole-entry editor could do that per-line
  // editing has no equivalent for otherwise. Lives next to the edited-dot
  // in the reader's entry header, only shown once there's actually an
  // override to discard.

  // Takes an array — a section groups several BHA-original entries under
  // one title, and any number of them (not necessarily all) can carry an
  // edit worth discarding.
  function confirmDiscardEdit(entries) {
    if (!entries.length) return;
    var many = entries.length > 1;
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>Discard ' + (many ? 'these edits' : 'this edit') + '?</h3>' +
      '<p>Reverts ' + (many ? 'these rules' : 'this rule') + ' back to BHA’s own published text — live on the public site immediately. There is no draft or review step to undo it from here (though every change is a normal git commit, so it can always be reverted from GitHub).</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Discard</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      doDiscardEdit(entries.slice());
    });
  }

  function doDiscardEdit(entries) {
    if (!entries.length) {
      clearReaderEditor();
      renderReaderBody($('readerSearch') ? $('readerSearch').value : '');
      return;
    }
    var e = entries.shift();
    fetch('/api/save-rule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: e.key, delete: true })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'revert failed'); });
      return r.json();
    }).then(function () {
      delete state.overrides[e.key];
      doDiscardEdit(entries);
    }).catch(function (err) {
      alert('Could not revert: ' + err.message);
    });
  }

  // ---- word definitions (glossary) --------------------------------------

  // Official terms (state.definitions, from BHA's own Definitions chapter)
  // plus admin-added custom ones (state.customDefinitions) rendered as one
  // combined, always-fresh list — custom terms aren't merged into
  // state.definitions itself so there's one source of truth for each.
  function allDefinitionRows() {
    var customRows = Object.keys(state.customDefinitions).map(function (id) {
      var c = state.customDefinitions[id];
      return { id: id, term: c.term, html: c.html, custom: true, updatedAt: c.updatedAt };
    });
    return state.definitions.concat(customRows);
  }

  $('defSearch').addEventListener('input', function () {
    state.defQuery = $('defSearch').value.toLowerCase();
    renderDefinitionsList();
  });

  if ($('defNewBtn')) $('defNewBtn').addEventListener('click', openNewDefinitionEditor);

  function renderDefinitionsList() {
    var q = state.defQuery;
    var all = allDefinitionRows();
    var rows = all.filter(function (t) {
      return !q || t.term.toLowerCase().indexOf(q) !== -1;
    });
    $('defCount').textContent = all.length ? rows.length + ' of ' + all.length + ' terms' : '';

    var list = $('defResultList');
    list.innerHTML = '';
    if (!rows.length) { list.innerHTML = '<div class="empty-state">No matches.</div>'; return; }

    var frag = document.createDocumentFragment();
    rows.forEach(function (t) {
      var eff = t.custom ? { edited: false } : effectiveDefinition(t);
      var row = document.createElement('div');
      row.className = 'result-row' + (t.id === state.selectedDefId ? ' active' : '');
      row.innerHTML = '<span class="title">' + escapeHtml(t.term) + '</span>' +
        (t.custom ? '<span class="custom-pill">Custom</span>' : '') +
        (eff.edited ? '<span class="edited-dot" title="Has a published edit"></span>' : '');
      row.addEventListener('click', function () { selectDefinition(t.id); });
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  function selectDefinition(id) {
    state.selectedDefId = id;
    renderDefinitionsList();
    var t = allDefinitionRows().filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var pane = $('defEditorPane');

    if (t.custom) {
      pane.innerHTML =
        '<div class="editor-card">' +
        '<span class="code-badge custom-badge">Custom term</span>' +
        '<label for="defTerm">Term</label>' +
        '<input type="text" id="defTerm" value="' + escapeHtml(t.term) + '">' +
        '<label for="defBody">Definition</label>' +
        '<textarea id="defBody"></textarea>' +
        '<div class="hint">Plain text — blank lines start a new paragraph. Not part of BHA’s official Definitions chapter — matched (case-insensitively, whole word) wherever this exact term appears in rule text on the public site.</div>' +
        '<div class="editor-actions">' +
        '<button class="save" id="defSaveBtn">Publish change</button>' +
        '<button class="revert" id="defDeleteBtn" type="button">Delete</button>' +
        (t.updatedAt ? '<span class="hint" style="margin:0">Added ' + new Date(t.updatedAt).toLocaleString() + '</span>' : '') +
        '</div>' +
        '<div class="save-msg" id="defSaveMsg"></div>' +
        '</div>';
      $('defBody').value = stripHtml(t.html);
      $('defSaveBtn').addEventListener('click', function () { confirmSaveCustomDefinition(id); });
      $('defDeleteBtn').addEventListener('click', function () { confirmDeleteCustomDefinition(id); });
      return;
    }

    var eff = effectiveDefinition(t);
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

  // ---- word definitions — admin-added custom terms -----------------------

  function openNewDefinitionEditor() {
    state.selectedDefId = null;
    renderDefinitionsList();
    var pane = $('defEditorPane');
    pane.innerHTML =
      '<div class="editor-card">' +
      '<span class="code-badge custom-badge">New custom term</span>' +
      '<label for="defTerm">Term</label>' +
      '<input type="text" id="defTerm" placeholder="e.g. Photo Finish">' +
      '<label for="defBody">Definition</label>' +
      '<textarea id="defBody" placeholder="means…"></textarea>' +
      '<div class="hint">Plain text — blank lines start a new paragraph. Not part of BHA’s official Definitions chapter — this adds a new glossary entry, matched (case-insensitively, whole word) wherever the exact term appears in rule text on the public site.</div>' +
      '<div class="editor-actions">' +
      '<button class="save" id="defSaveBtn">Publish change</button>' +
      '</div>' +
      '<div class="save-msg" id="defSaveMsg"></div>' +
      '</div>';
    $('defSaveBtn').addEventListener('click', function () { confirmSaveCustomDefinition(null); });
  }

  function confirmSaveCustomDefinition(id) {
    var term = $('defTerm').value.trim();
    var bodyText = $('defBody').value;
    var msg = $('defSaveMsg');
    if (!term) { msg.textContent = 'Give the term some text first.'; msg.className = 'save-msg err'; return; }
    if (!bodyText.trim()) { msg.textContent = 'Give the definition some text first.'; msg.className = 'save-msg err'; return; }
    var dup = allDefinitionRows().some(function (t) {
      return t.id !== id && t.term.toLowerCase() === term.toLowerCase();
    });
    if (dup) { msg.textContent = 'A term with that exact text already exists.'; msg.className = 'save-msg err'; return; }

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
      doSaveCustomDefinition(id, term, plainTextToHtml(bodyText));
    });
  }

  function doSaveCustomDefinition(id, term, html) {
    var msg = $('defSaveMsg');
    var btn = $('defSaveBtn');
    btn.disabled = true;
    msg.textContent = 'Publishing…';
    msg.className = 'save-msg';

    fetch('/api/save-custom-definition', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, term: term, html: html })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'save failed'); });
      return r.json();
    }).then(function (j) {
      var savedId = j.id || id;
      state.customDefinitions[savedId] = { term: term, html: html, updatedAt: new Date().toISOString() };
      state.selectedDefId = savedId;
      renderDefinitionsList();
      selectDefinition(savedId);
      $('defSaveMsg').textContent = 'Published — live on the public site now.';
      $('defSaveMsg').className = 'save-msg ok';
    }).catch(function (err) {
      msg.textContent = 'Could not publish: ' + err.message;
      msg.className = 'save-msg err';
      btn.disabled = false;
    });
  }

  function confirmDeleteCustomDefinition(id) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>Delete this definition?</h3>' +
      '<p>This removes it from the public site immediately — there is no draft or review step to undo it from here (though every change is a normal git commit, so it can always be reverted from GitHub).</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Delete</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      doDeleteCustomDefinition(id);
    });
  }

  function doDeleteCustomDefinition(id) {
    var msg = $('defSaveMsg');
    var btn = $('defDeleteBtn');
    if (btn) btn.disabled = true;
    if (msg) { msg.textContent = 'Deleting…'; msg.className = 'save-msg'; }

    fetch('/api/save-custom-definition', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, delete: true })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'delete failed'); });
      return r.json();
    }).then(function () {
      delete state.customDefinitions[id];
      state.selectedDefId = null;
      renderDefinitionsList();
      $('defEditorPane').innerHTML = '<div class="empty-state">Pick a term on the left to edit its definition.</div>';
    }).catch(function (err) {
      if (msg) { msg.textContent = 'Could not delete: ' + err.message; msg.className = 'save-msg err'; }
      if (btn) btn.disabled = false;
    });
  }

  // ---- render -------------------------------------------------------

  function render() {
    $('loginView').style.display = state.loggedIn ? 'none' : '';
    $('appShell').style.display = state.loggedIn ? 'flex' : 'none';
    $('who').style.display = state.loggedIn ? 'flex' : 'none';
  }

  // ---- media library ------------------------------------------------
  //
  // Browses uploads/ in the GitHub repo (the same folder upload-guide.js
  // already writes into) via list-media.js, lets an admin drop in new
  // images/PDFs (upload-media.js) and create subfolders — really just a
  // .gitkeep placeholder, since git has no empty-directory concept
  // (create-media-folder.js). Scoped to uploads/ only: never browses the
  // rest of the repo (source code, admin.js, etc).
  var MEDIA_ROOT = 'uploads';
  var MEDIA_MAX_BYTES = 3 * 1024 * 1024;
  var MEDIA_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];

  function fileToBase64Media(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('could not read that file')); };
      reader.readAsDataURL(file);
    });
  }

  function formatBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderMediaBreadcrumb() {
    var parts = state.mediaPath.split('/');
    var crumb = $('mediaBreadcrumb');
    var acc = '';
    crumb.innerHTML = parts.map(function (part, i) {
      acc = i === 0 ? part : acc + '/' + part;
      var label = i === 0 ? 'Media library' : part;
      return '<button type="button" class="media-crumb" data-path="' + escapeHtml(acc) + '">' + escapeHtml(label) + '</button>' +
        (i < parts.length - 1 ? '<span class="media-crumb-sep">/</span>' : '');
    }).join('');
    Array.prototype.forEach.call(crumb.querySelectorAll('.media-crumb'), function (btn) {
      btn.addEventListener('click', function () { loadMediaFolder(btn.dataset.path); });
    });
  }

  function renderMediaGrid() {
    renderMediaBreadcrumb();
    var grid = $('mediaGrid');
    if (!grid) return;
    if (state.mediaItems === null) { grid.innerHTML = '<div class="empty-state">Loading…</div>'; return; }
    if (!state.mediaItems.length) { grid.innerHTML = '<div class="empty-state">Nothing here yet.</div>'; return; }
    grid.innerHTML = state.mediaItems.map(function (it) {
      if (it.type === 'dir') {
        return '<button type="button" class="media-card media-folder" data-path="' + escapeHtml(it.path) + '">' +
          '<span class="media-thumb folder-thumb"><svg width="26" height="26" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1 1 0 0 1 3 3.5h3l1.2 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z"></path></svg></span>' +
          '<span class="media-name">' + escapeHtml(it.name) + '</span>' +
          '</button>';
      }
      var ext = (it.name.split('.').pop() || '').toLowerCase();
      var isImage = MEDIA_IMAGE_EXT.indexOf(ext) !== -1;
      var thumb = isImage && it.url
        ? '<img class="media-thumb" src="' + escapeHtml(it.url) + '" alt="">'
        : '<span class="media-thumb file-thumb"><svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h5.5L12 5v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"></path><path d="M9.3 2.5V5H12"></path></svg></span>';
      return '<a class="media-card" href="' + escapeHtml(it.url || '#') + '" target="_blank" rel="noopener">' +
        thumb +
        '<span class="media-name">' + escapeHtml(it.name) + '</span>' +
        '<span class="media-meta">' + escapeHtml(formatBytes(it.size)) + '</span>' +
        '</a>';
    }).join('');
    Array.prototype.forEach.call(grid.querySelectorAll('.media-folder'), function (btn) {
      btn.addEventListener('click', function () { loadMediaFolder(btn.dataset.path); });
    });
  }

  function loadMediaFolder(path) {
    state.mediaPath = path || MEDIA_ROOT;
    state.mediaItems = null;
    renderMediaGrid();
    var msg = $('mediaMsg');
    if (msg) { msg.textContent = ''; msg.className = 'save-msg'; }
    fetch('/api/list-media?path=' + encodeURIComponent(state.mediaPath))
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'could not load'); });
        return r.json();
      })
      .then(function (j) {
        state.mediaItems = j.items || [];
        renderMediaGrid();
      })
      .catch(function (err) {
        state.mediaItems = [];
        renderMediaGrid();
        if (msg) { msg.textContent = 'Could not load: ' + err.message; msg.className = 'save-msg err'; }
      });
  }

  if ($('mediaUploadBtn')) $('mediaUploadBtn').addEventListener('click', function () { $('mediaFileInput').click(); });
  if ($('mediaFileInput')) $('mediaFileInput').addEventListener('change', function () {
    var file = $('mediaFileInput').files[0];
    $('mediaFileInput').value = '';
    if (!file) return;
    if (file.size > MEDIA_MAX_BYTES) {
      var msg = $('mediaMsg');
      if (msg) { msg.textContent = 'That file is too large — up to 3MB.'; msg.className = 'save-msg err'; }
      return;
    }
    var msg = $('mediaMsg');
    if (msg) { msg.textContent = 'Uploading…'; msg.className = 'save-msg'; }
    fileToBase64Media(file).then(function (b64) {
      return fetch('/api/upload-media', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: state.mediaPath, filename: file.name, fileBase64: b64 })
      });
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'upload failed'); });
      return r.json();
    }).then(function () {
      if (msg) { msg.textContent = 'Uploaded.'; msg.className = 'save-msg ok'; }
      loadMediaFolder(state.mediaPath);
    }).catch(function (err) {
      if (msg) { msg.textContent = 'Could not upload: ' + err.message; msg.className = 'save-msg err'; }
    });
  });

  function openMediaFolderPanel() {
    var panel = $('mediaFolderPanel');
    var card = $('mediaFolderCard');
    card.innerHTML =
      '<span class="code-badge">New folder</span>' +
      '<label for="mediaFolderName">Folder name</label>' +
      '<input type="text" id="mediaFolderName" placeholder="e.g. Fixture Lists">' +
      '<div class="editor-actions">' +
      '<button class="save" id="mediaFolderSaveBtn">Create folder</button>' +
      '<button class="revert" id="mediaFolderCancelBtn" type="button">Cancel</button>' +
      '</div>' +
      '<div class="save-msg" id="mediaFolderMsg"></div>';
    $('mediaFolderCancelBtn').addEventListener('click', function () {
      panel.close ? panel.close() : panel.removeAttribute('open');
    });
    $('mediaFolderSaveBtn').addEventListener('click', function () {
      var name = $('mediaFolderName').value.trim();
      var msg = $('mediaFolderMsg');
      if (!name) { msg.textContent = 'Give the folder a name first.'; msg.className = 'save-msg err'; return; }
      var btn = $('mediaFolderSaveBtn');
      btn.disabled = true;
      msg.textContent = 'Creating…';
      msg.className = 'save-msg';
      fetch('/api/create-media-folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: state.mediaPath, name: name })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'could not create folder'); });
        return r.json();
      }).then(function () {
        panel.close ? panel.close() : panel.removeAttribute('open');
        loadMediaFolder(state.mediaPath);
      }).catch(function (err) {
        msg.textContent = 'Could not create folder: ' + err.message;
        msg.className = 'save-msg err';
        btn.disabled = false;
      });
    });
    if (typeof panel.showModal === 'function') panel.showModal();
    else panel.setAttribute('open', '');
  }
  if ($('mediaCreateFolderBtn')) $('mediaCreateFolderBtn').addEventListener('click', openMediaFolderPanel);

  // ---- users -------------------------------------------------------
  //
  // A roster of who has admin access — not a real per-user login. This app
  // still authenticates everyone with the one shared password (see
  // api/login.js); adding/removing someone here records who currently has
  // access, it doesn't itself grant or revoke the ability to sign in.
  // Kept in its own admin-users.json (via api/list-users.js /
  // api/save-user.js) rather than overrides.json, since that file is served
  // publicly and this one holds team members' names and emails.

  function loadUsers() {
    state.users = null;
    renderUsersList();
    fetch('/api/list-users')
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'could not load'); });
        return r.json();
      })
      .then(function (j) {
        state.users = j.users || {};
        renderUsersList();
      })
      .catch(function (err) {
        state.users = {};
        renderUsersList();
        var list = $('usersList');
        if (list) list.innerHTML = '<div class="empty-state">Could not load: ' + escapeHtml(err.message) + '</div>';
      });
  }

  function userInitials(name, email) {
    var label = (name || email || '').trim();
    if (!label) return '?';
    if (name) {
      var parts = name.trim().split(/\s+/);
      return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    }
    return label[0].toUpperCase();
  }

  function renderUsersList() {
    var list = $('usersList');
    if (!list) return;
    if (state.users === null) { list.innerHTML = '<div class="empty-state">Loading…</div>'; return; }
    var emails = Object.keys(state.users).sort(function (a, b) {
      return (state.users[a].grantedAt || '').localeCompare(state.users[b].grantedAt || '');
    });
    if (!emails.length) { list.innerHTML = '<div class="empty-state">No one added yet — use "+ Add user" above.</div>'; return; }
    list.innerHTML = '<div class="users-row head"><div>Name</div><div>Email</div><div>Access granted</div><div></div></div>' +
      emails.map(function (email) {
        var u = state.users[email];
        var when = u.grantedAt ? new Date(u.grantedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
        return '<div class="users-row" data-email="' + escapeHtml(email) + '">' +
          '<div class="user-name-cell"><div class="user-avatar">' + escapeHtml(userInitials(u.name, email)) + '</div>' +
          '<span class="user-name">' + escapeHtml(u.name || email) + '</span></div>' +
          '<div class="user-email">' + escapeHtml(email) + '</div>' +
          '<div class="user-since">' + when + '</div>' +
          '<button type="button" class="icon-btn" title="Remove admin access" aria-label="Remove admin access">' +
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4h10"></path><path d="M6.5 4V2.7c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7V4"></path><path d="M4.2 4l.6 8.7c0 .7.6 1.3 1.3 1.3h3.8c.7 0 1.3-.6 1.3-1.3L11.8 4"></path></svg>' +
          '</button></div>';
      }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.users-row[data-email] .icon-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.users-row');
        confirmRemoveUser(row.dataset.email, state.users[row.dataset.email].name);
      });
    });
  }

  function confirmRemoveUser(email, name) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>Remove admin access?</h3>' +
      '<p><b>' + escapeHtml(name || email) + '</b> (' + escapeHtml(email) + ') will be removed from this list. ' +
      'Since everyone signs in with the same shared password, this is a record-keeping change — it doesn’t on its own change who can sign in.</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Remove</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      fetch('/api/save-user', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, delete: true })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'remove failed'); });
        return r.json();
      }).then(function () {
        delete state.users[email];
        renderUsersList();
      }).catch(function (err) {
        alert('Could not remove: ' + err.message);
      });
    });
  }

  function openAddUserPanel() {
    var panel = $('userAddPanel');
    var card = $('userAddCard');
    card.innerHTML =
      '<span class="code-badge">Add a new admin user</span>' +
      '<label for="userAddEmail">Email address</label>' +
      '<input type="email" id="userAddEmail" placeholder="name@bha.co.uk">' +
      '<label for="userAddName">Name <span style="font-weight:400;color:var(--ink-soft)">(optional)</span></label>' +
      '<input type="text" id="userAddName" placeholder="e.g. Charlotte Reid">' +
      '<div class="hint">They’ll get full admin access — the same as everyone else on this list. There’s no partial or view-only option.</div>' +
      '<div class="editor-actions">' +
      '<button class="save" id="userAddSaveBtn">Grant admin access</button>' +
      '<button class="revert" id="userAddCancelBtn" type="button">Cancel</button>' +
      '</div>' +
      '<div class="save-msg" id="userAddMsg"></div>';
    $('userAddCancelBtn').addEventListener('click', function () {
      panel.close ? panel.close() : panel.removeAttribute('open');
    });
    $('userAddSaveBtn').addEventListener('click', function () {
      var email = $('userAddEmail').value.trim();
      var name = $('userAddName').value.trim();
      var msg = $('userAddMsg');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Enter a valid email address.'; msg.className = 'save-msg err'; return; }
      var btn = $('userAddSaveBtn');
      btn.disabled = true;
      msg.textContent = 'Adding…';
      msg.className = 'save-msg';
      fetch('/api/save-user', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, name: name })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'could not add'); });
        return r.json();
      }).then(function (j) {
        state.users = j.users || state.users;
        renderUsersList();
        panel.close ? panel.close() : panel.removeAttribute('open');
      }).catch(function (err) {
        msg.textContent = 'Could not add: ' + err.message;
        msg.className = 'save-msg err';
        btn.disabled = false;
      });
    });
    if (typeof panel.showModal === 'function') panel.showModal();
    else panel.setAttribute('open', '');
  }
  if ($('userAddBtn')) $('userAddBtn').addEventListener('click', openAddUserPanel);

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
      if (view === 'media' && state.mediaItems === null) loadMediaFolder(MEDIA_ROOT);
      if (view === 'users' && state.users === null) loadUsers();
    });
  });
  // "Books" is the working screen and the default view.
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
