/*
 * BHA Rules parser.
 *
 * Turns the raw book JSON from rules.britishhorseracing.com
 * (GET /api/books/{id}?with=sections) into a flat list of searchable
 * entries. Runs both in Node (build-time snapshot) and in the browser
 * (live refresh), so it must not touch the DOM.
 *
 * Numbering: the BHA site numbers rules with CSS counters —
 * `.counter-level-1` blocks increment a manual-wide rule counter,
 * `.counter-level-2/3` produce 45.1 / 45.1.1 sub-numbers. Manuals
 * ("preface" sections) are lettered A, B, C… in published order, which
 * is how codes like (F)45 arise. Codes ("chapter") and guides
 * ("appendix") restart numbering per document.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BHAParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ALLOWED_TAGS = 'b|strong|i|em|u|br|sub|sup';

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'");
  }

  // Keep only harmless inline formatting; drop every attribute.
  function cleanHtml(h) {
    h = String(h || '').replace(/[\n\r\t]+/g, ' ');
    h = h.replace(new RegExp('<(\\/?)(' + ALLOWED_TAGS + ')\\b[^>]*>', 'gi'), '<$1$2>');
    h = h.replace(new RegExp('<(?!\\/?(?:' + ALLOWED_TAGS + ')>)[^>]*>', 'gi'), '');
    h = h.replace(/\s{2,}/g, ' ');
    return h.trim();
  }

  function toText(h) {
    return decodeEntities(String(h || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- component walking -------------------------------------------------

  function counterLevel(comp) {
    var wc = (comp.data && comp.data.wrapperClass) || {};
    if (!wc['counter-enabled']) return 0;
    if (wc['counter-level-1']) return 1;
    if (wc['counter-level-2']) return 2;
    if (wc['counter-level-3']) return 3;
    return 0;
  }

  function deepScan(node, out) {
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object' && 'type' in node[0]) {
        flattenComponents(node, out);
      } else {
        node.forEach(function (v) { deepScan(v, out); });
      }
    } else if (node && typeof node === 'object') {
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];
        if (v && typeof v === 'object') deepScan(v, out);
      }
    }
  }

  // Flatten a component tree into renderable blocks in document order.
  // Block: {level: 0|1|2|3, html, text}
  function flattenComponents(comps, out) {
    if (!Array.isArray(comps)) return;
    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      if (!c || typeof c !== 'object') continue;
      var type = c.type;
      if (type === 'textblock') {
        var html = cleanHtml(c.html);
        if (html) out.push({ level: counterLevel(c), html: html, text: toText(c.html) });
      } else if (type === 'table') {
        var d = c.data || {};
        var rowsHtml = '';
        var textParts = [];
        var addRows = function (rows, cellTag) {
          var h = '';
          (rows || []).forEach(function (row) {
            h += '<tr>';
            (row || []).forEach(function (cell) {
              var ch = cleanHtml(cell && cell.content);
              textParts.push(toText(cell && cell.content));
              h += '<' + cellTag + '>' + ch + '</' + cellTag + '>';
            });
            h += '</tr>';
          });
          return h;
        };
        var thead = addRows(d.thead, 'th');
        var tbody = addRows(d.tbody, 'td');
        if (thead) rowsHtml += '<thead>' + thead + '</thead>';
        if (tbody) rowsHtml += '<tbody>' + tbody + '</tbody>';
        if (d.caption) {
          rowsHtml = '<caption>' + cleanHtml(d.caption) + '</caption>' + rowsHtml;
          textParts.unshift(toText(d.caption));
        }
        if (rowsHtml) {
          out.push({
            level: counterLevel(c),
            html: '<div class="tbl-wrap"><table>' + rowsHtml + '</table></div>',
            text: textParts.filter(Boolean).join(' ')
          });
        }
      } else if (type === 'bullets') {
        var list = (c.data && c.data.list) || [];
        var items = '';
        var btext = [];
        list.forEach(function (it) {
          var ih = cleanHtml(it && it.html);
          if (ih) { items += '<li>' + ih + '</li>'; btext.push(toText(it.html)); }
        });
        if (items) out.push({ level: counterLevel(c), html: '<ul>' + items + '</ul>', text: btext.join(' ') });
      } else if (type === 'image') {
        // skip images — not useful for text search
      } else {
        // container (one-column, two-column, column, collapsible, …):
        // a collapsible may carry a visible title
        var title = c.data && (c.data.title || c.data.label);
        if (typeof title === 'string' && title.trim()) {
          out.push({ level: 0, html: '<b>' + cleanHtml(title) + '</b>', text: toText(title) });
        }
        // child components can hide at any depth (e.g. `column` keeps
        // them in data.list[].nested) — deep-scan for arrays of
        // objects that carry a `type` key
        deepScan(c, out);
      }
    }
  }

  // ---- book parsing ------------------------------------------------------

  function parseBook(book) {
    var sections = book.sections || [];
    var orderMap = book.section_order || {};
    var byParent = {};
    sections.forEach(function (s) {
      var p = s.parent_id || 0;
      (byParent[p] = byParent[p] || []).push(s);
    });
    var ord = function (s) {
      var o = orderMap[String(s.id)];
      return o == null ? (s.order || 0) : o;
    };
    Object.keys(byParent).forEach(function (k) {
      byParent[k].sort(function (a, b) { return ord(a) - ord(b); });
    });

    var tops = byParent[0] || [];
    var prefaces = tops.filter(function (s) { return s.type === 'preface'; });
    var chapters = tops.filter(function (s) { return s.type === 'chapter'; });
    var appendices = tops.filter(function (s) { return s.type === 'appendix'; });

    var entries = [];
    var manuals = [];

    function getComps(s) {
      var c = s.components;
      if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = []; } }
      return Array.isArray(c) ? c : [];
    }

    // Walk one top-level document (a manual, code or guide). Rule
    // numbering is continuous across all its nested sections, matching
    // the site's single-page-per-document rendering.
    function walkDocument(top, letter, groupKind) {
      var rule = 0;

      function leafPath(chain) {
        return chain.map(function (s) { return tidyTitle(s.title); }).filter(Boolean);
      }

      // The BHA's CMS lets editors flag a section as newly added/changed for
      // the current version (`highlighted === 'new'`) — that's what renders
      // as the grey "new" pill on the official site's contents list. A rule
      // inherits it from its own section or any ancestor, including the
      // top-level document itself.
      function chainIsNew(chain) {
        if (top.highlighted === 'new') return true;
        return chain.some(function (s) { return s.highlighted === 'new'; });
      }

      function visit(sec, chain) {
        var blocks = [];
        flattenComponents(getComps(sec), blocks);

        var current = null; // open rule entry
        var pending = [];   // unnumbered blocks waiting for the next rule
        var sub2 = 0, sub3 = 0;

        function flushPendingInto(entry) {
          pending.forEach(function (b) {
            entry.html += '<p class="l0">' + b.html + '</p>';
            entry.text += ' ' + b.text;
          });
          pending = [];
        }

        blocks.forEach(function (b) {
          if (b.level === 1) {
            rule += 1; sub2 = 0; sub3 = 0;
            current = {
              code: letter ? letter + rule : null,
              num: rule,
              kind: groupKind,
              doc: tidyTitle(top.title),
              letter: letter || null,
              title: tidyTitle(sec.title),
              path: leafPath(chain),
              isNew: chainIsNew(chain),
              html: '',
              text: ''
            };
            entries.push(current);
            flushPendingInto(current);
            // Bare number only — matches how sub-clauses below are numbered,
            // and how BHA's own site numbers every level; the manual letter
            // is never repeated inline in their own text either.
            current.html += '<p class="l1"><span class="rn">' + rule + '</span>' + b.html + '</p>';
            current.text += ' ' + b.text;
          } else if (b.level === 2 && current) {
            sub2 += 1; sub3 = 0;
            current.html += '<p class="l2"><span class="rn">' + rule + '.' + sub2 + '</span>' + b.html + '</p>';
            current.text += ' ' + b.text;
          } else if (b.level === 3 && current) {
            sub3 += 1;
            current.html += '<p class="l3"><span class="rn">' + rule + '.' + sub2 + '.' + sub3 + '</span>' + b.html + '</p>';
            current.text += ' ' + b.text;
          } else if (current) {
            current.html += '<p class="l0">' + b.html + '</p>';
            current.text += ' ' + b.text;
          } else {
            pending.push(b);
          }
        });

        // Unnumbered content in a section with no rules (intro pages,
        // penalty tables, guides): emit as a single titled entry.
        if (pending.length) {
          var entry = {
            code: null,
            num: null,
            kind: groupKind,
            doc: tidyTitle(top.title),
            letter: letter || null,
            title: tidyTitle(sec.title),
            path: leafPath(chain),
            isNew: chainIsNew(chain),
            html: '',
            text: ''
          };
          pending.forEach(function (b) {
            entry.html += '<p class="l0">' + b.html + '</p>';
            entry.text += ' ' + b.text;
          });
          pending = [];
          entries.push(entry);
        }

        (byParent[sec.id] || []).forEach(function (child) {
          visit(child, chain.concat([child]));
        });
      }

      (byParent[top.id] || []).forEach(function (child) {
        visit(child, [child]);
      });
      // top-level doc may itself hold content (single-page codes)
      var ownBlocks = [];
      flattenComponents(getComps(top), ownBlocks);
      if (ownBlocks.length) visit({ id: -top.id, title: top.title, components: [] }, []);
      return rule;
    }

    // Titles in the CMS have erratic casing ("wHIP - rULE (f)45");
    // normalise gently.
    function tidyTitle(t) {
      t = String(t || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) return t;
      var letters = t.replace(/[^a-zA-Z]/g, '');
      var upper = letters.replace(/[^A-Z]/g, '').length;
      // mixed/broken casing → title case; keep natural-looking titles as-is
      if (letters && (upper / letters.length > 0.6 || /[a-z][A-Z]/.test(t))) {
        t = t.toLowerCase().replace(/(^|[\s(\-\/])([a-z])/g, function (_, a, b) { return a + b.toUpperCase(); });
        t = t.replace(/\bBha\b/g, 'BHA').replace(/\(([a-z])\)/g, function (_, l) { return '(' + l.toUpperCase() + ')'; });
      }
      return t.replace(/\bCODES\b/g, 'Codes').replace(/\bCODE\b/g, 'Code');
    }

    prefaces.forEach(function (p, i) {
      var letter = String.fromCharCode(65 + i); // A, B, C…
      var count = walkDocument(p, letter, 'manual');
      manuals.push({ letter: letter, title: tidyTitle(p.title), rules: count });
    });
    chapters.forEach(function (c) { walkDocument(c, null, 'code'); });
    appendices.forEach(function (a) { walkDocument(a, null, 'guide'); });

    entries.forEach(function (e, i) {
      e.id = i;
      e.text = (e.title + ' ' + e.path.join(' ') + ' ' + e.doc + ' ' + e.text).toLowerCase().replace(/\s+/g, ' ').trim();
    });

    return {
      bookId: book.id,
      version: book.version || (book.major + '.' + book.minor),
      publishedAt: book.published_at || null,
      year: book.year || null,
      manuals: manuals,
      entries: entries
    };
  }

  // ---- glossary --------------------------------------------------------
  //
  // The rulebook has a real "Definitions" chapter (one flat list of terms,
  // no child sections) where every entry is a single textblock shaped as
  // "<b>Term</b> means/is …", occasionally followed by plain continuation
  // paragraphs or a bullet list for multi-part definitions. This walks
  // that chapter once and turns it into {term, html} pairs — the same
  // real BHA text the official site uses for its own defined-term
  // tooltips, just re-parsed rather than invented.
  function extractDefinitions(book) {
    var sections = book.sections || [];
    var defsChapter = sections.filter(function (s) {
      return s.type === 'chapter' && String(s.title || '').trim().toLowerCase() === 'definitions';
    })[0];
    if (!defsChapter) return [];

    function getComps(s) {
      var c = s.components;
      if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = []; } }
      return Array.isArray(c) ? c : [];
    }

    var blocks = [];
    flattenComponents(getComps(defsChapter), blocks);

    var termRe = /^\s*<b>([^<]+?)<\/b>\s*([\s\S]*)$/;
    var terms = [];
    var current = null;
    blocks.forEach(function (b) {
      var m = termRe.exec(b.html);
      var term = m && decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
      // a handful of bolded notes aren't defined terms at all (e.g. the
      // "(For the purposes of these Rules…)" preamble) — those start with
      // "(" or run long, unlike a real term, which is a short noun phrase
      if (m && term && term.length < 90 && term.charAt(0) !== '(') {
        if (current) terms.push(current);
        current = { term: term, html: m[2] ? '<p class="l0">' + m[2] + '</p>' : '' };
      } else if (current) {
        current.html += '<p class="l0">' + b.html + '</p>';
      }
    });
    if (current) terms.push(current);

    terms.forEach(function (t, i) {
      t.id = i;
      t.slug = t.term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    });
    return terms;
  }

  return { parseBook: parseBook, extractDefinitions: extractDefinitions, cleanHtml: cleanHtml, toText: toText, escapeHtml: escapeHtml };
});
