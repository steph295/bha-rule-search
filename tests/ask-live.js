// Two-turn check of the *deployed* assistant's wording (spends a few cents of
// API credit): node tests/ask-live.js [base-url]
// The offline suite (npm test) checks what the model is given; this checks
// what it says, using the same two questions.
'use strict';
const base = (process.argv[2] || 'https://bha-rule-search.vercel.app').replace(/\/$/, '');
const Q1 = 'A jockey was late getting into the parade ring. Which rule covers it?';
const Q2 = 'Is the jockey or the trainer in breach, and what\'s the penalty?';

async function ask(messages) {
  const r = await fetch(base + '/api/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ messages })
  });
  const j = await r.json();
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (j.error || ''));
  return j;
}
let failed = 0;
function check(name, ok) { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name); if (!ok) failed++; }

(async () => {
  const a1 = await ask([{ role: 'user', content: Q1 }]);
  console.log('\n--- Q1 ---\n' + a1.answer + '\nsources: ' + a1.sources.map((s) => s.n + ':' + (s.ref || s.title)).join(', ') + '\n');
  check('Q1 names Rule (E)31', /\(E\)31|E31/.test(a1.answer));
  check('Q1 cites it', /⟦\d+⟧/.test(a1.answer) && a1.sources.some((s) => s.ref === 'E31'));

  const cited = a1.sources.map((s) => ({ kind: s.kind, ref: s.ref, title: s.title, doc: s.doc }));
  const a2 = await ask([
    { role: 'user', content: Q1 },
    { role: 'assistant', content: a1.answer.replace(/⟦\d+⟧/g, ''), cited },
    { role: 'user', content: Q2 }
  ]);
  console.log('--- Q2 ---\n' + a2.answer + '\nsources: ' + a2.sources.map((s) => s.n + ':' + (s.ref || s.title) + ' [' + s.kind + ']').join(', ') + '\n');
  check('Q2 does not say the documents lack the answer', !/(don.t|do not|doesn.t|does not|isn.t|not) (cover|contain|include)/i.test(a2.answer.split('\n')[0]));
  check('Q2 says who is liable (names the jockey)', /jockey/i.test(a2.answer));
  check('Q2 states entry point B', /entry point/i.test(a2.answer) && /\bB\b/.test(a2.answer));
  check('Q2 explains what B means (Band B / £140)', /Band B|£\s?140/.test(a2.answer));
  check('Q2 is cited', /⟦\d+⟧/.test(a2.answer));
  check('Q2 cites the penalty entry or the bands', a2.sources.some((s) => s.kind === 'penalty' || /Fixed Penalty Bands/i.test(s.title) || (s.ref === 'E31')));
  console.log('\n' + (failed ? failed + ' check(s) failed' : 'all checks passed'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
