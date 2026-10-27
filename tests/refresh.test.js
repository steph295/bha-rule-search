// Safety checks for the rules refresh (tools/refresh-rules.js): a broken download must be refused,
// and bookkeeping-only edits must not count as a change. Offline — uses the saved rulebook.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../tools/refresh-rules.js');

const book = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'book34.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(book));
const prev = R.stats(book);

test('1. the saved rulebook passes its own checks', () => {
  assert.deepEqual(R.validate(clone(), prev), []);
  assert.ok(prev.rules > 500 && prev.sections > 500, JSON.stringify(prev));
});

test('2. an empty, truncated or version-less download is refused', () => {
  assert.ok(R.validate({ sections: [], version: '1', year: 'x' }, prev).length, 'no sections');
  assert.ok(R.validate(null, prev).length, 'nothing at all');
  const noVersion = clone(); delete noVersion.version;
  assert.match(R.validate(noVersion, prev).join(), /version/);
  const noDate = clone(); delete noDate.year;
  assert.match(R.validate(noDate, prev).join(), /effective date/);
  const half = clone(); half.sections = half.sections.slice(0, Math.floor(half.sections.length / 2));
  assert.match(R.validate(half, prev).join(), /far fewer/, 'half the sections');
});

test('3. losing a lot of numbered rules is refused even if the section count looks fine', () => {
  const gutted = clone();
  gutted.sections.forEach((s) => { if (s.type === 'preface') s.components = []; }); // empties every rule manual's own text
  const sectionsOnly = clone();
  sectionsOnly.sections.forEach((s) => { if (s.type === 'section') s.components = []; });
  assert.match(R.validate(sectionsOnly, prev).join(), /far fewer (rules|entries)/);
});

test('4. editing only bookkeeping fields is not a change; editing a rule is', () => {
  const same = clone();
  same.updated_at = '2030-01-01T00:00:00+00:00';
  same.sections.forEach((s) => { s.updated_at = '2030-01-01T00:00:00+00:00'; });
  assert.equal(R.contentHash(same), R.contentHash(book), 'timestamps alone do not count');
  const edited = clone();
  const sec = edited.sections.find((s) => s.html || (s.components && s.components.length));
  if (typeof sec.html === 'string' && sec.html) sec.html += ' changed'; else sec.components = sec.components.concat([{ type: 'textblock', html: 'changed' }]);
  assert.notEqual(R.contentHash(edited), R.contentHash(book), 'a wording change counts');
  const bumped = clone(); bumped.version = '9.9.9';
  assert.notEqual(R.contentHash(bumped), R.contentHash(book), 'a new version counts');
});

test('5. the published book is the latest published, non-archived one in the main library', () => {
  const pick = R.pickBook([
    { id: 1, published: true, archived: false, library_id: 0, published_at: '2030-01-01' },
    { id: 2, published: true, archived: false, library_id: 2, published_at: '2026-06-09' },
    { id: 3, published: false, archived: false, library_id: 2, published_at: '2027-01-01' },
    { id: 4, published: true, archived: true, library_id: 2, published_at: '2028-01-01' }
  ]);
  assert.equal(pick.id, 2);
});
