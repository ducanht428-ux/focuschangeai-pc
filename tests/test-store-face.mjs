// Round-trip test for the face keys in store.mjs, with a localStorage stub.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const S = await import(
  '../dist/js/store.mjs');

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(got));
};

check('default roster', S.students().map((s) => s.id), ['hs1']);
const hs2 = S.addStudent('Nguyen Van B');
check('second student added', S.students().length, 2);

const v = [0.32, 0.06, 0.29, 0.7, 1.31, 1.15, 0.92, 0.95, 0.49, 0.95, 0.95, 0.38, 0.38, 0.54,
  0.54, 0.27, 0.27, 0.15, 0.0, 0.0];
check('empty bank before enrolment', S.faceVectors(hs2.id), []);
check('saveFace returns true', S.saveFace(hs2.id, [v, v]), true);
check('round-trip keeps 20 dims', S.faceVectors(hs2.id).length, 2);
check('values survive', S.faceVectors(hs2.id)[0], v);

// Corrupt and half-written banks must read back as no face, never as a partial match.
mem.set('focuschange.face.' + hs2.id, '[null,"x",[1,2,null],[0.1,0.2]]');
check('junk filtered out', S.faceVectors(hs2.id), [[0.1, 0.2]]);
// A NaN written straight through JSON.stringify lands as null, which is not a number and is dropped.
mem.set('focuschange.face.' + hs2.id, JSON.stringify([[0.1, NaN], [0.3, 0.4]]));
check('non-finite coordinate filtered', S.faceVectors(hs2.id), [[0.3, 0.4]]);
mem.set('focuschange.face.' + hs2.id, '{not json');
check('unparseable reads back empty', S.faceVectors(hs2.id), []);

S.saveFace(hs2.id, [v]);
check('roster only lists students with a bank', Object.keys(S.faceRoster()), [hs2.id]);
S.saveFace('hs1', [v, v]);
check('roster has two banks', Object.keys(S.faceRoster()).sort(), ['hs1', hs2.id].sort());

check('clearFace works', S.clearFace(hs2.id), true);
check('roster falls back to one', Object.keys(S.faceRoster()), ['hs1']);

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
