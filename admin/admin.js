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
    return e.code || (e.kind === 'code' || e.kind === 'guide' ? 'Code' : e.kind === 'bhagi' ? 'BHAGI' : 'Guide');
  }

  function stripHtml(html) {
    return String(html || '')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // keep <b>/<i>/<u> (and their closing tags) — everything else goes,
      // same inline-tag whitelist plainTextToHtml re-escapes back in on save
      .replace(/<(?!\/?(?:b|i|u)>)[^>]+>/gi, '')
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
  var INLINE_TAGS = ['b', 'i', 'u'];
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
    var o = state.overrides[e.key];
    var flag = o && (o.flag === 'not-new' ? 'none' : o.flag);
    return {
      title: (o && o.title) || e.title,
      html: (o && o.html) || e.html,
      isNew: flag === 'new' ? true : flag ? false : !!e.isNew,
      isUpdated: flag === 'updated',
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
      var entries = (rules.entries || []).map(function (e) {
        return { kind: e.kind, code: e.code, letter: e.letter, num: e.num, doc: e.doc, title: e.title, html: e.html, path: e.path || [], isNew: !!e.isNew };
      }).concat((guides.entries || []).concat(uploadedGuideEntries).map(function (g) {
        return { kind: g.kind === 'bhagi' ? 'bhagi' : 'guidedoc', code: g.code, letter: null, num: null, doc: g.doc, title: g.title, html: g.html, path: [g.cat], _uploadId: g._uploadId };
      }));
      entries.forEach(function (e) { e.key = e._uploadId || computeKey(e); });
      state.entries = entries;
      state.overrides = overrides.overrides || {};
      state.definitionOverrides = overrides.definitionOverrides || {};
      state.bookOverrides = overrides.bookOverrides || {};
      state.customDefinitions = overrides.customDefinitions || {};
      state.uploadedGuides = uploadedGuides;
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

  function renderReaderSection(n, depth) {
    var frag = document.createDocumentFragment();
    var head = document.createElement('div');
    head.id = n.id;
    head.dataset.outlineId = n.id;
    head.dataset.outlineLabel = n.label;
    head.className = 'reader-heading depth-' + depth;
    head.innerHTML = (n.badge ? '<span class="code">' + escapeHtml(n.badge) + '</span>' : '') + escapeHtml(n.label);
    frag.appendChild(head);
    n.entries.forEach(function (e) { frag.appendChild(renderReaderEntry(e)); });
    n.children.forEach(function (c) { frag.appendChild(renderReaderSection(c, depth + 1)); });
    return frag;
  }

  // Reads the flag currently published for this entry (if any) — used so a
  // line edit's save doesn't silently clear an existing New/Updated flag,
  // and vice versa (save-rule.js replaces the whole override record, so
  // every save has to resend whatever it isn't changing).
  function currentFlagOverride(e) {
    var o = state.overrides[e.key];
    var f = o && o.flag;
    return f === 'not-new' ? 'none' : (f || '');
  }

  function renderReaderEntry(e) {
    var eff = effective(e);
    var block = document.createElement('div');
    block.className = 'reader-entry' + (e.key === state.selectedKey ? ' selected' : '');
    block.dataset.key = e.key;
    // The whole-entry New/Updated flag is set from the title's own editor
    // (opened via its pencil) rather than sitting as a checkbox pair next to
    // every single title all the time — quieter, and consistent with every
    // other edit control here only appearing once you click in to edit.
    // The pencil sits at the right of the whole head row (same box style as
    // a line's pencil) and shows on hovering anywhere in that row, not just
    // when the mouse is right over the title text — matching how a line's
    // pencil reveals on hovering the whole line, not just its text.
    var titleHtml = '<span class="reader-entry-title">' + escapeHtml(eff.title) + '</span>';
    block.innerHTML = '<div class="reader-entry-head' + (state.readerEditMode ? ' editable' : '') + '">' +
      '<span class="' + codeClass(e) + '">' + escapeHtml(dispCode(e)) + '</span>' +
      titleHtml +
      (eff.isNew ? '<span class="pill-new">New</span>' : eff.isUpdated ? '<span class="pill-updated">Updated</span>' : '') +
      (eff.edited ? '<span class="edited-dot" title="Has a published edit"></span>' : '') +
      (eff.edited && state.readerEditMode ? '<button type="button" class="discard-edit-btn">Discard edit</button>' : '') +
      (state.readerEditMode ? makePencilBtn('Edit the title').outerHTML : '') +
      '</div>' +
      '<div class="rfull-body"></div>';
    renderEntryBody(block.querySelector('.rfull-body'), e, eff.html, block);
    var titlePencil = block.querySelector('.reader-entry-head > .edit-line-pencil');
    if (titlePencil) titlePencil.addEventListener('click', function () { openTitleEditor(e, block); });
    var discardBtn = block.querySelector('.discard-edit-btn');
    if (discardBtn) discardBtn.addEventListener('click', function () { confirmDiscardEdit(e); });
    return block;
  }

  function markEdited(block, e) {
    if (!block) return;
    if (!block.querySelector('.edited-dot')) {
      var dot = document.createElement('span');
      dot.className = 'edited-dot';
      dot.title = 'Has a published edit';
      block.querySelector('.reader-entry-title').insertAdjacentElement('afterend', dot);
    }
    if (e && state.readerEditMode && !block.querySelector('.discard-edit-btn')) {
      var discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'discard-edit-btn';
      discardBtn.textContent = 'Discard edit';
      discardBtn.addEventListener('click', function () { confirmDiscardEdit(e); });
      block.querySelector('.edited-dot').insertAdjacentElement('afterend', discardBtn);
    }
  }

  // The reader's shared right-hand editor — one at a time, so clicking a
  // different pencil (or the title's) simply replaces whatever was open
  // rather than letting several edits pile up inline through the document.
  function readerEditorPane() { return $('readerEditorSlot'); }
  function clearReaderEditor() { readerEditorPane().innerHTML = ''; }

  // The whole-entry New/Updated flag lives here, in the title's own editor,
  // rather than as a checkbox pair sitting next to every title all the time.
  function openTitleEditor(e, block) {
    var eff = effective(e);
    var pane = readerEditorPane();
    pane.innerHTML =
      '<div class="editor-card">' +
      '<span class="code-badge">' + escapeHtml(dispCode(e)) + ' — title</span>' +
      '<label for="titleEditInput">Title</label>' +
      '<input type="text" id="titleEditInput" value="' + escapeHtml(eff.title) + '">' +
      '<label>Flag</label>' +
      '<div class="reader-entry-flag" style="margin-left:0">' +
      '<label><input type="checkbox" id="titleFlagNew"' + (eff.isNew ? ' checked' : '') + '> New</label>' +
      '<label><input type="checkbox" id="titleFlagUpdated"' + (eff.isUpdated ? ' checked' : '') + '> Updated</label>' +
      '</div>' +
      '<div class="hint">Flags this whole entry — leave both unchecked for Auto, deferring to the automatic new-entries detection.</div>' +
      '<div class="editor-actions">' +
      '<button class="save" id="titleSaveBtn">Publish change</button>' +
      '<button class="revert" id="titleCancelBtn" type="button">Cancel</button>' +
      '</div>' +
      '<div class="save-msg" id="titleSaveMsg"></div>' +
      '</div>';
    var input = $('titleEditInput');
    input.focus();
    input.select();
    $('titleFlagNew').addEventListener('change', function () { if (this.checked) $('titleFlagUpdated').checked = false; });
    $('titleFlagUpdated').addEventListener('change', function () { if (this.checked) $('titleFlagNew').checked = false; });
    $('titleCancelBtn').addEventListener('click', clearReaderEditor);
    $('titleSaveBtn').addEventListener('click', function () {
      var newTitle = input.value.trim();
      if (!newTitle) { alert('Give it a title first.'); return; }
      var flag = $('titleFlagNew').checked ? 'new' : $('titleFlagUpdated').checked ? 'updated' : '';
      confirmPublish('Publish this title?', function () { saveTitleChange(e, block, newTitle, flag); });
    });
  }

  function saveTitleChange(e, block, newTitle, flag) {
    var btn = $('titleSaveBtn');
    if (btn) btn.disabled = true;
    fetch('/api/save-rule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: e.key, title: newTitle, flag: flag })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'save failed'); });
      return r.json();
    }).then(function () {
      state.overrides[e.key] = Object.assign({}, state.overrides[e.key], { title: newTitle, flag: flag, updatedAt: new Date().toISOString() });
      // Full re-render of just this entry — simplest way to keep the title
      // text, the New/Updated pill and the edited-dot all in sync with
      // whatever changed, rather than patching each by hand.
      block.replaceWith(renderReaderEntry(e));
      clearReaderEditor();
    }).catch(function (err) {
      alert('Could not publish: ' + err.message);
      if (btn) btn.disabled = false;
    });
  }

  // Shared confirm step for every publish from the reader's right-hand
  // editor (title, line edits, new lines) — goes live immediately, so this
  // is the one pause before that happens.
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

  // ---- reader: per-line editing --------------------------------------
  //
  // Editing happens one rule clause at a time — a pencil next to each line
  // (only shown once "Edit" is toggled on, and only on hovering that line)
  // opens that line in the reader's shared right-hand editor, rather than
  // expanding a textarea inline in the document — only one line is ever
  // being edited at a time, and the reading pane itself stays uncluttered.
  // The rule numbering (the leading "45.1" etc, a <span class="rn">) is
  // preserved untouched — only the prose after it is ever editable. Only
  // <p> lines get a pencil; tables/lists stay read-only here rather than
  // risk mangling their structure through a plain-text round trip.
  //
  // New/Updated flags live at this same per-line level (a data-flag
  // attribute on the <p>, set from the line's own editor) rather than only
  // on the whole entry — an update often touches one clause, not the whole
  // rule. Consecutive lines sharing a flag are shown under one merged tag
  // rather than repeating it per line (see renderEntryBody's grouping).
  function lineParts(el) {
    var clone = el.cloneNode(true);
    var rn = clone.querySelector(':scope > .rn');
    var rnHtml = rn ? rn.outerHTML : '';
    if (rn) rn.parentNode.removeChild(rn);
    return {
      tag: el.tagName.toLowerCase(), className: el.className, rnHtml: rnHtml,
      text: stripHtml(clone.innerHTML), flag: el.getAttribute('data-flag') || ''
    };
  }

  function rebuildLine(parts, newText, flag) {
    var bodyHtml = escapeHtmlAllowInline(newText).replace(/\n/g, '<br>');
    var clsAttr = parts.className ? ' class="' + parts.className + '"' : '';
    var flagAttr = flag ? ' data-flag="' + flag + '"' : '';
    return '<' + parts.tag + clsAttr + flagAttr + '>' + parts.rnHtml + bodyHtml + '</' + parts.tag + '>';
  }

  function makePencilBtn(title) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'edit-line-pencil';
    btn.title = title;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z"></path></svg>';
    return btn;
  }

  function makeAddGap() {
    var gap = document.createElement('div');
    gap.className = 'edit-line-gap';
    gap.innerHTML = '<button type="button" class="edit-line-add" title="Add a line here">' +
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"></path></svg></button>';
    return gap;
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

  // Renders an entry's body, grouping consecutive same-flagged lines under
  // one tag (read mode and edit mode alike), and — only in edit mode —
  // adding a hover-reveal pencil per line plus "+" gaps between lines.
  // `lineEls` (the original flat line elements, before any grouping/edit
  // wrappers) is stashed on the container so a save can reconstruct the
  // full entry HTML without caring how the DOM is currently decorated.
  function renderEntryBody(container, e, html, block) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var lineEls = Array.prototype.slice.call(tmp.children);
    container.innerHTML = '';
    if (!lineEls.length) { container.innerHTML = html; return; }
    container._lineEls = lineEls;

    if (state.readerEditMode) {
      var leadGap = makeAddGap();
      container.appendChild(leadGap);
      leadGap.querySelector('.edit-line-add').addEventListener('click', function () {
        openLineEditor(e, container, block, 'insert', null);
      });
    }

    var group = null, groupFlag = null;
    lineEls.forEach(function (el) {
      if (el.tagName !== 'P') {
        group = null; groupFlag = null;
        container.appendChild(el);
        return;
      }
      var flag = el.getAttribute('data-flag') || '';
      var target;
      if (flag && flag === groupFlag) {
        target = group;
      } else {
        group = flag ? flagGroupStart(flag) : null;
        groupFlag = flag;
        if (group) container.appendChild(group);
        target = group || container;
      }

      if (!state.readerEditMode) { target.appendChild(el); return; }

      var row = document.createElement('div');
      row.className = 'edit-line-row';
      var content = document.createElement('div');
      content.className = 'edit-line-content';
      content.appendChild(el);
      var pencil = makePencilBtn('Edit this line');
      row.appendChild(content);
      row.appendChild(pencil);
      target.appendChild(row);
      pencil.addEventListener('click', function () { openLineEditor(e, container, block, 'edit', el); });

      var gap = makeAddGap();
      target.appendChild(gap);
      gap.querySelector('.edit-line-add').addEventListener('click', function () {
        openLineEditor(e, container, block, 'insert', el);
      });
    });
  }

  // Numbers a newly-inserted line off the line it follows, with a letter
  // suffix (6.2 -> 6.2A) rather than renumbering — same reasoning as
  // everywhere else in this app: a rule's number is something people cite,
  // so nothing below the insertion point should ever shift. Inserting at
  // the very top of an entry (afterEl === null) has no number to append a
  // letter to, so it gets no visible number at all — same as an unnumbered
  // lead-in paragraph.
  function nextInsertedNumber(afterEl) {
    if (!afterEl) return '';
    var rn = afterEl.querySelector(':scope > .rn');
    var base = rn ? stripHtml(rn.innerHTML).trim() : '';
    if (!base) return '';
    var m = /^(.*?)([A-Z]?)$/.exec(base);
    return m[1] + (m[2] ? String.fromCharCode(m[2].charCodeAt(0) + 1) : 'A');
  }

  // The one editor for both "edit this line" (mode 'edit', targetEl is the
  // line) and "add a line" (mode 'insert', targetEl is the line to insert
  // after, or null for the very top) — rendered into the reader's shared
  // right-hand panel.
  function openLineEditor(e, container, block, mode, targetEl) {
    var isInsert = mode === 'insert';
    var parts = isInsert ? null : lineParts(targetEl);
    var newNumber = isInsert ? nextInsertedNumber(targetEl) : null;
    var pane = readerEditorPane();
    pane.innerHTML =
      '<div class="editor-card">' +
      '<span class="code-badge">' + escapeHtml(dispCode(e)) + (isInsert ? ' — new line' : ' — line') + '</span>' +
      (isInsert && newNumber ? '<div class="new-line-number">Numbered <b>' + escapeHtml(newNumber) + '</b> — sits here without renumbering anything below.</div>' : '') +
      '<label for="lineEditText">Text</label>' +
      '<textarea id="lineEditText" class="edit-line-textarea" placeholder="' + (isInsert ? 'New line…' : '') + '"></textarea>' +
      '<label>Flag</label>' +
      '<div class="reader-entry-flag" style="margin-left:0">' +
      '<label><input type="checkbox" id="lineFlagNew"' + (!isInsert && parts.flag === 'new' ? ' checked' : '') + '> New</label>' +
      '<label><input type="checkbox" id="lineFlagUpdated"' + (!isInsert && parts.flag === 'updated' ? ' checked' : '') + '> Updated</label>' +
      '</div>' +
      '<div class="hint">Flags this specific line — leave both unchecked for none.</div>' +
      '<div class="editor-actions">' +
      '<button class="save" id="lineSaveBtn">' + (isInsert ? 'Add line' : 'Publish change') + '</button>' +
      '<button class="revert" id="lineCancelBtn" type="button">Cancel</button>' +
      '</div>' +
      '<div class="save-msg" id="lineSaveMsg"></div>' +
      '</div>';
    var ta = $('lineEditText');
    ta.value = isInsert ? '' : parts.text;
    ta.focus();
    if (!isInsert) ta.selectionStart = ta.selectionEnd = ta.value.length;
    $('lineFlagNew').addEventListener('change', function () { if (this.checked) $('lineFlagUpdated').checked = false; });
    $('lineFlagUpdated').addEventListener('change', function () { if (this.checked) $('lineFlagNew').checked = false; });
    $('lineCancelBtn').addEventListener('click', clearReaderEditor);
    $('lineSaveBtn').addEventListener('click', function () {
      var text = ta.value;
      if (isInsert && !text.trim()) { alert('Give the new line some text first.'); return; }
      var flag = $('lineFlagNew').checked ? 'new' : $('lineFlagUpdated').checked ? 'updated' : '';
      var newHtml;
      if (isInsert) {
        var className = targetEl ? targetEl.className : 'l0';
        var rnHtml = newNumber ? '<span class="rn">' + escapeHtml(newNumber) + '</span>' : '';
        var bodyHtml = escapeHtmlAllowInline(text).replace(/\n/g, '<br>');
        var clsAttr = className ? ' class="' + className + '"' : '';
        var flagAttr = flag ? ' data-flag="' + flag + '"' : '';
        newHtml = '<p' + clsAttr + flagAttr + '>' + rnHtml + bodyHtml + '</p>';
      } else {
        newHtml = rebuildLine(parts, text, flag);
      }
      confirmPublish(isInsert ? 'Publish this new line?' : 'Publish this change?', function () {
        saveLineChange(e, container, block, mode, targetEl, newHtml);
      });
    });
  }

  // Rebuilds the full entry HTML from the original flat line list (stashed
  // by renderEntryBody), substituting or inserting just the one changed
  // line — independent of however the live DOM is currently wrapped for
  // display, so grouping/edit decoration never has to be undone first.
  function reconstructEntryHtml(lineEls, mode, targetEl, newHtml) {
    var out = [];
    if (mode === 'insert' && targetEl === null) out.push(newHtml);
    lineEls.forEach(function (el) {
      if (mode === 'edit' && el === targetEl) { out.push(newHtml); return; }
      out.push(el.outerHTML);
      if (mode === 'insert' && el === targetEl) out.push(newHtml);
    });
    return out.join('');
  }

  function saveLineChange(e, container, block, mode, targetEl, newHtml) {
    var btn = $('lineSaveBtn');
    var msg = $('lineSaveMsg');
    var fullHtml = reconstructEntryHtml(container._lineEls, mode, targetEl, newHtml);
    btn.disabled = true;
    msg.textContent = 'Publishing…';
    msg.className = 'save-msg';
    fetch('/api/save-rule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: e.key, html: fullHtml, flag: currentFlagOverride(e) })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'save failed'); });
      return r.json();
    }).then(function () {
      state.overrides[e.key] = Object.assign({}, state.overrides[e.key], { html: fullHtml, updatedAt: new Date().toISOString() });
      markEdited(block, e);
      renderEntryBody(container, e, effective(e).html, block);
      clearReaderEditor();
    }).catch(function (err) {
      msg.textContent = 'Could not publish: ' + err.message;
      msg.className = 'save-msg err';
      btn.disabled = false;
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
      var codeClass = e.kind === 'bhagi' ? 'code bhagi' : (e.kind === 'guidedoc' ? 'code guidedoc' : 'code');
      var codeLabel = e.code || (e.kind === 'code' || e.kind === 'guide' ? 'Code' : e.kind === 'bhagi' ? 'BHAGI' : 'Guide');
      row.innerHTML = '<span class="' + codeClass + '">' + escapeHtml(codeLabel) + '</span>' +
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

  function confirmDiscardEdit(e) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<h3>Discard this edit?</h3>' +
      '<p>Reverts this entry back to BHA’s own published text — live on the public site immediately. There is no draft or review step to undo it from here (though every change is a normal git commit, so it can always be reverted from GitHub).</p>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="confirm">Discard edit</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('.confirm').addEventListener('click', function () {
      overlay.remove();
      doDiscardEdit(e);
    });
  }

  function doDiscardEdit(e) {
    fetch('/api/save-rule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: e.key, delete: true })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'revert failed'); });
      return r.json();
    }).then(function () {
      delete state.overrides[e.key];
      clearReaderEditor();
      renderReaderBody($('readerSearch') ? $('readerSearch').value : '');
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
