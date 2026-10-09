/* BHA Rules Assistant — talks to the same-origin /api/ask. Conversation lives
 * only in this page (nothing is stored); the last few turns are re-sent each
 * time so follow-ups keep their context. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var SUGGESTIONS = [
    'What is the penalty for excessive use of the whip?',
    'When can a race be abandoned?',
    'How long must a trainer keep medication records?',
    'What counts as a Prohibited Substance?'
  ];
  var messages = []; // [{role, content, cited?}] — what's sent to the API (plain text, no citation markers)
  var busy = false;

  var form = $('askForm'), input = $('q'), sendBtn = $('send');
  var hero = $('hero'), thread = $('thread'), composer = $('composer');

  var hour = new Date().getHours();
  $('greeting').textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  // The box is a textarea so a longer question can wrap; Enter sends, Shift+Enter adds a line.
  function fitInput() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
  input.addEventListener('input', fitInput);
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit(); }
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- hero content ----
  SUGGESTIONS.forEach(function (q) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = q;
    b.addEventListener('click', function () { ask(q); });
    $('suggest').appendChild(b);
  });

  // ---- answer rendering ----
  // Escaped text with a tiny subset of markdown (bold, "- " bullets); the
  // ⟦n⟧ markers the server leaves after cited stretches become citation chips.
  function renderAnswer(text) {
    var html = '', inList = false, para = [];
    function flushPara() { if (para.length) { html += '<p>' + para.join(' ') + '</p>'; para = []; } }
    function inline(line) {
      return esc(line)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/⟦(\d+)⟧/g, '<button type="button" class="cite" data-n="$1">$1</button>');
    }
    text.split('\n').forEach(function (raw) {
      var line = raw.trim();
      var bullet = /^[-•*]\s+(.*)$/.exec(line);
      if (bullet) {
        flushPara();
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + inline(bullet[1]) + '</li>';
      } else if (!line) {
        flushPara();
        if (inList) { html += '</ul>'; inList = false; }
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        para.push(inline(line));
      }
    });
    flushPara();
    if (inList) html += '</ul>';
    return html;
  }

  var KIND_LABEL = { rule: 'Rule', code: 'Code', guide: 'Guidance', definition: 'Definition', penalty: 'Penalty table' };
  var KIND_CLASS = { rule: '', code: 'code', guide: 'guide', definition: 'def', penalty: 'code' };

  function sourceCard(s) {
    var link = '';
    if (s.kind === 'guide' && s.url) {
      link = '<a class="src-link" href="' + esc(s.url + (s.page ? '#page=' + s.page : '')) + '" target="_blank" rel="noopener">Open the PDF' + (s.page ? ' (page ' + esc(s.page) + ')' : '') + ' ↗</a>';
    } else {
      link = '<a class="src-link" href="https://rules.britishhorseracing.com" target="_blank" rel="noopener">Check on the official Rules of Racing ↗</a>';
    }
    return '<div class="src-card" data-n="' + s.n + '" hidden>' +
      '<div class="src-top"><span class="badge ' + (KIND_CLASS[s.kind] || '') + '">' + esc((s.ref ? s.ref + ' · ' : '') + (KIND_LABEL[s.kind] || 'Source')) + '</span>' +
      '<span class="src-title">' + esc(s.title) + '</span></div>' +
      (s.doc && s.doc !== s.title ? '<div class="src-doc">' + esc(s.doc) + '</div>' : '') +
      '<div class="src-text">' + esc(s.text) + '</div>' + link + '</div>';
  }

  function renderSources(sources) {
    if (!sources.length) return '';
    return '<div class="sources"><div class="sources-label">Sources</div><div class="src-chips">' +
      sources.map(function (s) {
        return '<button type="button" class="src-chip" data-n="' + s.n + '"><span class="n">' + s.n + '</span><span class="t">' +
          esc((s.ref ? s.ref + ' ' : '') + s.title) + '</span></button>';
      }).join('') + '</div>' + sources.map(sourceCard).join('') + '</div>';
  }

  function toggleSource(botEl, n) {
    var card = botEl.querySelector('.src-card[data-n="' + n + '"]');
    if (!card) return;
    var open = card.hidden;
    Array.prototype.forEach.call(botEl.querySelectorAll('.src-card'), function (c) { c.hidden = true; });
    Array.prototype.forEach.call(botEl.querySelectorAll('.src-chip, .cite'), function (c) { c.classList.remove('on'); });
    if (open) {
      card.hidden = false;
      Array.prototype.forEach.call(botEl.querySelectorAll('[data-n="' + n + '"].src-chip, [data-n="' + n + '"].cite'), function (c) { c.classList.add('on'); });
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ---- thread ----
  function enterChat() {
    if (document.body.classList.contains('chatting')) return;
    document.body.classList.add('chatting');
    thread.hidden = false;
    thread.innerHTML = '<div class="thread-head"><button type="button" id="newQ">New question</button></div>';
    $('newQ').addEventListener('click', reset);
    composer.hidden = false;
    composer.appendChild(form);
    input.placeholder = 'Ask a follow-up…';
    input.rows = 1; fitInput();
  }

  function reset() {
    messages = [];
    document.body.classList.remove('chatting');
    thread.hidden = true; thread.innerHTML = '';
    composer.hidden = true;
    hero.querySelector('.hero-inner').insertBefore(form, $('suggest'));
    input.placeholder = 'Ask about the Rules of Racing';
    input.value = ''; input.rows = 2; fitInput();
    window.scrollTo(0, 0);
  }

  function addMsg(cls, html) {
    var el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.innerHTML = '<div class="bubble">' + html + '</div>';
    thread.appendChild(el);
    el.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return el;
  }

  function ask(question) {
    question = String(question || '').trim();
    if (!question || busy) return;
    busy = true; sendBtn.disabled = true;
    enterChat();
    messages.push({ role: 'user', content: question });
    addMsg('user', esc(question));
    var bot = addMsg('bot', '<span class="typing"><i></i><i></i><i></i>&nbsp;Searching the Rules…</span>');
    input.value = ''; fitInput();

    fetch('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Something went wrong getting an answer. Please try again.');
        return j;
      });
    }).then(function (j) {
      bot.querySelector('.bubble').innerHTML = '<div class="answer">' + renderAnswer(j.answer || '') + '</div>' + renderSources(j.sources || []);
      // what this answer cited goes back with it, so a follow-up can keep those rules in scope
      messages.push({
        role: 'assistant',
        content: String(j.answer || '').replace(/⟦\d+⟧/g, ''),
        cited: (j.sources || []).map(function (src) { return { kind: src.kind, ref: src.ref, title: src.title, doc: src.doc }; })
      });
      bot.addEventListener('click', function (ev) {
        var t = ev.target.closest('.cite, .src-chip');
        if (t) toggleSource(bot, t.dataset.n);
      });
    }).catch(function (err) {
      messages.pop(); // let them retry the same question
      bot.classList.add('error');
      bot.querySelector('.bubble').textContent = err.message || 'Something went wrong. Please try again.';
    }).then(function () {
      busy = false; sendBtn.disabled = false;
      input.focus();
      bot.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  }

  form.addEventListener('submit', function (ev) { ev.preventDefault(); ask(input.value); });
})();
