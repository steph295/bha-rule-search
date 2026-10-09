// Regression tests for the /ask assistant's retrieval — run with `npm test`.
// They use the real rules/guides/definitions files and a fake Claude client,
// so they check *what the model is given* (the part that was failing), not
// the model's wording. tests/ask-live.js checks the wording against the
// deployed assistant.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const handler = require(path.join(root, 'api', 'ask.js'));
const L = require(path.join(root, 'api', '_ask-lib.js'));
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const Q1 = 'A jockey was late getting into the parade ring. Which rule covers it?';
const Q2 = 'Is the jockey or the trainer in breach, and what\'s the penalty?';
const REWRITTEN = 'Who is liable under Rule (E)31 and what does penalty entry point B mean?';

let ipCounter = 0;
function fakeClient(opts) {
  const calls = { rewrite: 0, answer: 0, rewriteInput: null, answerParams: null };
  const reply = (p) => {
    calls.answer++;
    calls.answerParams = p;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok', citations: [] }] };
  };
  return {
    calls,
    messages: {
      create: async (p) => {
        if (p.system === L.REWRITE_SYSTEM) {
          calls.rewrite++;
          calls.rewriteInput = p.messages[0].content;
          if (opts && opts.rewriteFails) throw new Error('rewrite down');
          return { content: [{ type: 'text', text: REWRITTEN }] };
        }
        return reply(p);
      }
    },
    beta: { messages: { create: async (p) => reply(p) } }
  };
}

function ask(client, messages) {
  handler._deps.client = client;
  return new Promise((resolve) => {
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; resolve(this); } };
    handler({ method: 'POST', headers: { host: 'x.test', origin: 'https://x.test', 'x-forwarded-for': '10.0.0.' + (++ipCounter) }, socket: {}, body: { messages } }, res);
  });
}

function documents(client) {
  return client.calls.answerParams.messages[client.calls.answerParams.messages.length - 1].content.filter((b) => b.type === 'document');
}
const byTitle = (docs, re) => docs.find((d) => re.test(d.title));

// what the client sends for the follow-up: the first answer, plus what it cited
const E31_RULE = { kind: 'rule', ref: 'E31', title: 'Mounting, Parades and proceeding to the start', doc: 'Preparing for the Race' };
const TURN_1 = [
  { role: 'user', content: Q1 },
  { role: 'assistant', content: 'Rule (E)31 covers it; the Table of Penalties lists late arrival of a Jockey in the parade ring at entry point B.', cited: [E31_RULE, { kind: 'code', ref: '', title: 'Mounting, Parades and proceeding to the start', doc: 'Table Of Penalties' }] },
  { role: 'user', content: Q2 }
];

test('1. "late into the parade ring" -> Rule (E)31, with its penalty entry', async () => {
  const c = fakeClient();
  const r = await ask(c, [{ role: 'user', content: Q1 }]);
  assert.equal(r.statusCode, 200);
  assert.equal(c.calls.rewrite, 0, 'a first question needs no rewrite');
  const docs = documents(c);
  assert.ok(byTitle(docs, /^E31 — /), 'Rule (E)31 is among the sources');
  assert.ok(byTitle(docs, /^Table of Penalties — Rule \(E\)31/), 'its Table of Penalties entry arrives with it');
  const row = byTitle(docs, /^Table of Penalties — Rule \(E\)31/).source.data;
  assert.match(row, /Late arrival of Jockey in parade ring \| Entry point: B/);
});

test('2. follow-up -> who is liable, entry point B, and what B means, all citable', async () => {
  const c = fakeClient();
  const r = await ask(c, TURN_1);
  assert.equal(r.statusCode, 200);
  assert.equal(c.calls.rewrite, 1, 'the follow-up is rewritten');
  assert.match(c.calls.rewriteInput, /Rule \(E\)31/, 'the rewrite is told which rule was cited');
  const docs = documents(c);

  const rule = byTitle(docs, /^E31 — /);
  assert.ok(rule, 'the rule cited earlier stays in scope');
  assert.match(rule.context, /All persons in the pre-parade ring/, 'who the rule addresses, from its wording');
  assert.match(rule.context, /Jockey\/Rider \("Late arrival of Jockey in parade ring", entry point B\)/, 'who the table row names');

  const pen = byTitle(docs, /^Table of Penalties — Rule \(E\)31/);
  assert.match(pen.source.data, /Entry point: B/);
  assert.match(pen.context, /single letter A–D, which is the matching lettered band/, 'what the letter means');
  assert.match(pen.context, /do not say what that abbreviation stands for/, 'RC is flagged as undefined, not guessed');

  const bands = byTitle(docs, /Fixed Penalty Bands/);
  assert.ok(bands, 'the Fixed Penalty Bands arrive with the penalty');
  assert.match(bands.source.data, /Band B \| £140 \| £280 \| £560 \| refer/);
  assert.ok(byTitle(docs, /^Definition: Entry Point/), 'the Entry Point definition arrives too');

  assert.match(c.calls.answerParams.system, /Who is in breach/);
  assert.match(c.calls.answerParams.system, /do not infer it from the nature of the offence/);
  for (const d of docs) assert.deepEqual(d.citations, { enabled: true }, 'every source is citable');
});

test('2b. the same follow-up still works if the rewrite call fails', async () => {
  const c = fakeClient({ rewriteFails: true });
  const r = await ask(c, TURN_1);
  assert.equal(r.statusCode, 200);
  const docs = documents(c);
  assert.ok(byTitle(docs, /^E31 — /));
  assert.ok(byTitle(docs, /^Table of Penalties — Rule \(E\)31/));
  assert.match(byTitle(docs, /Fixed Penalty Bands/).source.data, /Band B/);
});

test('2c. unknown or garbage "cited" keys from a client are ignored, not trusted', async () => {
  const c = fakeClient();
  const turns = JSON.parse(JSON.stringify(TURN_1));
  turns[1].cited = [{ kind: 'rule', ref: 'ZZ99', title: 'nope', doc: 'nope' }, null, 'x', { kind: 'penalty', ref: 'NOPE' }];
  const r = await ask(c, turns);
  assert.equal(r.statusCode, 200);
});

test('3. the Table of Penalties and its explanatory notes are fully indexed', () => {
  const idx = L.buildIndex({ rules: read('rules.json'), guides: read('guides.json'), definitions: read('definitions.json'), overrides: read('overrides.json') });
  const sections = read('rules.json').entries.filter((e) => e.doc === 'Table Of Penalties');
  assert.equal(sections.length, 63);
  const indexed = new Set(idx.docs.filter((d) => d.doc === 'Table Of Penalties').map((d) => d.title));
  sections.forEach((s) => assert.ok(indexed.has(s.title), 'indexed: ' + s.title));
  assert.equal(idx.bandDocs.length, 1, 'Fixed Penalty Bands');
  assert.ok(idx.entryPointDef, 'Entry Point definition');
  // every rule cross-referenced to a penalty row has a penalty passage with its rows
  let linked = 0;
  idx.penaltyByRef.forEach((p, ref) => {
    const pp = L.penaltyPassage(idx, ref);
    assert.ok(pp && pp.text.split('\n').length > 1, 'penalty passage for ' + ref);
    assert.ok(idx.ruleDocsByRef.has(ref), 'rule text for ' + ref);
    linked++;
  });
  assert.ok(linked > 100, 'penalty-linked rules: ' + linked);
});

test('4. who a rule applies to is captured from its wording, or stated as not named', () => {
  const idx = L.buildIndex({ rules: read('rules.json'), guides: read('guides.json'), definitions: read('definitions.json'), overrides: read('overrides.json') });
  const e31 = idx.ruleDocsByRef.get('E31')[0];
  assert.deepEqual(e31.applies.subjects.map((s) => s.role), ['Any person']);
  assert.deepEqual(e31.applies.tableRoles.map((t) => t.role), ['Jockey/Rider']);
  const e34 = idx.ruleDocsByRef.get('E34')[0];
  assert.ok(e34.applies.subjects.some((s) => s.role === 'Trainer'));
  assert.ok(!e34.applies.tableRoles.some((t) => t.role === 'Jockey/Rider'), 'an "Apprentice Jockey" is not also a plain Jockey');
  const unnamed = idx.docs.filter((d) => d.kind === 'rule' && d.applies && !d.applies.subjects.length && !d.applies.tableRoles.length);
  assert.ok(unnamed.length > 0);
  assert.match(unnamed[0].ctx, /does not name a particular person or role/, 'says so plainly instead of guessing');
});

test('5. admin glossary additions and edits reach the index', () => {
  const idx = L.buildIndex({
    rules: { entries: [] }, guides: { entries: [] },
    definitions: { terms: [{ id: 0, term: 'Foo', html: '<p>old meaning</p>' }] },
    overrides: {
      definitionOverrides: { 0: { html: '<p>new meaning</p>' } },
      customDefinitions: { c1: { term: 'RC', html: '<p>Racecourse Stewards</p>' } }
    }
  });
  assert.match(idx.defByTerm.get('foo').text, /new meaning/);
  assert.match(idx.defByTerm.get('rc').text, /Racecourse Stewards/);
});

test('6. typos in a question still find the right rule (the model gets the question as typed)', async () => {
  const typo = 'A jokcey was late getting into the paride ring. Which rule covers it?';
  const c = fakeClient();
  const r = await ask(c, [{ role: 'user', content: typo }]);
  assert.equal(r.statusCode, 200);
  assert.ok(byTitle(documents(c), /^E31 — /), 'Rule (E)31 is still found');
  assert.match(c.calls.answerParams.messages[c.calls.answerParams.messages.length - 1].content.find((b) => b.type === 'text').text, /jokcey/, 'the question reaches the model unchanged');
  assert.match(r.body.searchedFor, /jockey/, 'the corrected text is reported back');
  const clean = await ask(fakeClient(), [{ role: 'user', content: Q1 }]);
  assert.equal(clean.body.searchedFor, undefined, 'no note when nothing was corrected');
});

test('6b. spelling correction only touches words the rulebook has never seen', () => {
  const idx = L.buildIndex({ rules: read('rules.json'), guides: read('guides.json'), definitions: read('definitions.json'), overrides: read('overrides.json') });
  assert.deepEqual(L.correctQuery(idx, 'penalty for excessive use of the whip').changes, []);
  assert.deepEqual(L.correctQuery(idx, 'Rule (E)31 Stewards').changes, []);
  assert.deepEqual(L.correctQuery(idx, 'a trainner and the pentaly').changes.map((c) => c[1]), ['trainer', 'penalty']);
});

// Regression: "a jockey has fallen off before the start" was answered from the false-start
// rules, with "the documents don't cover remounting". Rule (F)5 (remounting) sits in the same
// short section as (F)4, and the chapter also holds "At the start" (F)6-(F)10.
const Q_FALLEN = 'a jockey has fallen off before the start, what do I do';

test('7. "fallen off before the start" reads the whole of The Start, remounting and the Starting Procedures Code', async () => {
  const c = fakeClient();
  const r = await ask(c, [{ role: 'user', content: Q_FALLEN }]);
  assert.equal(r.statusCode, 200);
  const docs = documents(c);
  const has = (re) => assert.ok(byTitle(docs, re), 'sources include ' + re);
  [1, 2, 3, 4, 5].forEach((n) => has(new RegExp('^F' + n + ' — Getting to the start')));   // the whole section, not just the hit
  [6, 7, 8].forEach((n) => has(new RegExp('^F' + n + ' — At the start')));
  has(/^F9 — Withdrawal of horses at the start/);
  has(/^F10 — Withdrawal of horses at the start/);
  has(/^F24 — Remounting/);
  has(/^F25 — Remounting/);
  assert.ok(docs.some((d) => /Starting Procedures Code/.test(d.title)), 'the Starting Procedures Code is searched too');
  assert.match(byTitle(docs, /^F5 — /).source.data, /remounts after leaving the parade ring/);

  // the model is told exactly which sections were read, and not to say "not covered" without them
  const last = c.calls.answerParams.messages[c.calls.answerParams.messages.length - 1].content;
  const note = last[last.length - 1].text;
  assert.match(note, /Sections searched/);
  assert.match(note, /Rules \(F\)5.*Getting to the start/);
  assert.match(note, /Rules \(F\)6.*At the start/);
  assert.match(c.calls.answerParams.system, /Do not say the Rules "don't cover" something unless you have read the sections/);
});

test('7b. everyday wording is also searched as the rulebook words it', () => {
  const terms = (q) => L.expandVocabulary(q).terms;
  assert.ok(terms('a jockey has fallen off').includes('unseated'));
  assert.ok(terms('the horse got loose').includes('loose'));
  assert.ok(terms('he got back on').includes('remount'));
  assert.ok(terms('the horse ran off').includes('bolted'));
  assert.deepEqual(terms('what is the penalty for the whip'), []);
});

test('7c. the Starting Procedures Code is indexed and searchable', () => {
  const idx = L.buildIndex({ rules: read('rules.json'), guides: read('guides.json'), definitions: read('definitions.json'), overrides: read('overrides.json') });
  assert.ok(idx.codeDocs.has('Starting Procedures Code'));
  const sections = new Set(idx.docs.filter((d) => d.doc === 'Starting Procedures Code').map((d) => d.title));
  ['Arrival of the horses at the Start', 'Horses that refuse to be loaded', 'Starting procedure', 'Standing Starts'].forEach((t) => assert.ok(sections.has(t), t));
});
