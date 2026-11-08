// Round-trip and falsification for the roster bundle in store.mjs.
//
// The property these tests exist to hold is the one the feature trades against convenience: importing a
// file must never replace what this machine already learned.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const { profileFromJson, profileToJson, summaryFromJson } = await import('../dist/js/habit.mjs');
const S = await import('../dist/js/store.mjs');

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(got));
};

const V1 = [0.32, 0.06, 0.29, 0.7, 1.31, 1.15, 0.92, 0.95, 0.49, 0.95, 0.95, 0.38, 0.38, 0.54,
  0.54, 0.27, 0.27, 0.15, 0.0, 0.0];
const V2 = V1.map((x, i) => (i === 0 ? 0.44 : x));

/** An eligible session summary in the stored shape, distinguishable by id. */
const sess = (id, validMs = 10 * 60 * 1000) => ({
  id, validMs, fr: 0.9, vr: 0.8, q: 80,
  m: new Array(12).fill(50), s: new Array(12).fill(5), n: new Array(12).fill(0),
  qn: 10, bi: 4, bb: 1, ba: 1, sl: 1,
});
/** The same record as the live object HabitProfile.commit takes. */
const live = (id, validMs) => summaryFromJson(sess(id, validMs));

// ---------------------------------------------------------------------------
// Machine A: two children, one with a face bank and a history, one with neither.
const a = S.addStudent('Tran Van A');
S.saveFace(a.id, [V1, V2]);
const pa = profileFromJson({ id: a.id, name: 'Tran Van A' });
pa.commit(live(1000));
pa.commit(live(2000));
pa.distanceScale = 1.4;
pa.calRawDistanceCm = 62;
S.saveProfile(pa);

const bundle = S.exportBundle();
check('bundle kind', bundle.kind, 'focuschange.pc.roster');
check('bundle version', bundle.version, 1);
check('bundle lists both rows', bundle.students.map((s) => s.name), ['Học sinh 1', 'Tran Van A']);
check('empty row exports no profile', bundle.students[0].profile, null);
check('empty row exports no faces', bundle.students[0].faces, []);
check('named row carries its bank', bundle.students[1].faces.length, 2);
check('named row carries its sessions', bundle.students[1].profile.sessions.length, 2);
check('bundle round-trips through JSON text',
  JSON.parse(JSON.stringify(bundle)).students[1].faces[0], V1);

// ---------------------------------------------------------------------------
// Machine B: a fresh install has hs1 and nothing else. Importing A's file into it must land the data.
mem.clear();
check('B starts with the default row', S.students().map((s) => s.id), ['hs1']);
let r = S.importBundle(JSON.parse(JSON.stringify(bundle)));
check('nothing refused', r.reason, '');
check('A came in under its own id', r.added, 1);
check('A kept its id', S.students().map((s) => s.id).includes(a.id), true);
check('both faces imported', S.faceVectors(a.id), [V1, V2]);
check('history imported', S.loadProfile(a.id).sessionCount(), 2);
check('calibration imported', S.loadProfile(a.id).distanceScale, 1.4);
check('the default row was not renamed', S.nameOf('hs1'), 'Học sinh 1');
check('B did not lose its own row', S.students().length, 2);

// Re-importing the same file is a no-op: the property that makes a double click safe.
r = S.importBundle(JSON.parse(JSON.stringify(bundle)));
check('second import adds no row', r.added, 0);
check('second import writes no bank', r.faces, 0);
check('second import reports the kept bank', r.facesKept, 1);
check('second import reports the known sessions', r.sessionsKnown, 2);
check('second import adds no session', r.sessions, 0);
check('sessions did not double', S.loadProfile(a.id).sessionCount(), 2);
check('roster still two rows', S.students().length, 2);

// A session the local copy does not have still arrives after a first run was recorded here: the history
// is a merge, not an all-or-nothing import.
mem.clear();
const p0 = profileFromJson({ id: 'm1', name: 'Merge Test' });
S.saveProfile(p0);
r = S.importBundle({ kind: 'focuschange.pc.roster', version: 1, students: [{
  id: 'm1', name: 'Merge Test', profile: { id: 'm1', name: 'Merge Test', sessions: [sess(1000)] },
}] });
check('first session merged', S.loadProfile('m1').sessionCount(), 1);
r = S.importBundle({ kind: 'focuschange.pc.roster', version: 1, students: [{
  id: 'm1', name: 'Merge Test', profile: { id: 'm1', name: 'Merge Test', sessions: [sess(1000), sess(2000)] },
}] });
check('only the new one was counted', r.sessions, 1);
check('the old one was recognised', r.sessionsKnown, 1);
check('two sessions now on file', S.loadProfile('m1').sessionCount(), 2);

// ---------------------------------------------------------------------------
// Falsification: B has already learned its own child on the default row, with a DIFFERENT name.
mem.clear();
const b = S.addStudent('Le Van B');
S.saveFace(b.id, [V1]);
const pb = profileFromJson({ id: b.id, name: b.name });
pb.commit(live(7000));
S.saveProfile(pb);
// The file below reuses b.id for another child, which is what an id collision looks like.
const stolen = {
  kind: 'focuschange.pc.roster', version: 1,
  students: [{ id: b.id, name: 'Someone Else', faces: [V2], profile: profileToJson((() => {
    const p = profileFromJson({ id: b.id, name: 'Someone Else' });
    p.commit(live(8000));
    return p;
  })()) }],
};
r = S.importBundle(stolen);
check('collision was re-keyed, not merged', r.rekeyed, 1);
check("B's own bank untouched", S.faceVectors(b.id), [V1]);
check("B's own history untouched", S.loadProfile(b.id).sessionCount(), 1);
check("B's own name untouched", S.nameOf(b.id), 'Le Van B');
const other = S.students().find((s) => s.name === 'Someone Else');
check('the file child got a row of its own', !!other, true);
check('and a different id', other.id !== b.id, true);
check('with its own bank', S.faceVectors(other.id), [V2]);

// The same collision on an EMPTY default row is adopted instead: that is the ordinary
// "second machine still on Học sinh 1" case and must not create a duplicate row.
mem.clear();
r = S.importBundle({ kind: 'focuschange.pc.roster', version: 1,
  students: [{ id: 'hs1', name: 'Tran Van A', faces: [V1], profile: null }] });
check('empty default row adopted the name', S.nameOf('hs1'), 'Tran Van A');
check('no duplicate row', S.students().length, 1);
check('its face landed', S.faceVectors('hs1'), [V1]);

// A default row that already has a face bank is not evidence of identity either: the bank is kept.
mem.clear();
S.saveFace('hs1', [V2]);
r = S.importBundle({ kind: 'focuschange.pc.roster', version: 1,
  students: [{ id: 'hs1', name: 'Tran Van A', faces: [V1], profile: null }] });
check('occupied default row was re-keyed', r.rekeyed, 1);
check('and the local bank survived', S.faceVectors('hs1'), [V2]);

// ---------------------------------------------------------------------------
// Junk files must be refused with a reason, and never clear anything.
mem.clear();
S.saveFace('hs1', [V1]);
const before = S.faceVectors('hs1');
const bad = [
  ['null', null],
  ['a list', []],
  ['wrong kind', { kind: 'something.else', version: 1, students: [{ id: 'x', name: 'X' }] }],
  ['newer version', { kind: 'focuschange.pc.roster', version: 99, students: [{ id: 'x', name: 'X' }] }],
  ['no students', { kind: 'focuschange.pc.roster', version: 1, students: [] }],
  ['unnamed students', { kind: 'focuschange.pc.roster', version: 1, students: [{ id: 'x', name: '   ' }] }],
];
for (const [label, obj] of bad) {
  const res = S.importBundle(obj);
  check('refused: ' + label, res.reason !== '', true);
}
check('nothing written by a refusal', S.students().length, 1);
check('the bank survived the refusals', S.faceVectors('hs1'), before);

// A file whose face vectors are junk imports the child but no bank, and a partly-junk bank keeps only
// the rows that are all finite numbers.
mem.clear();
r = S.importBundle({ kind: 'focuschange.pc.roster', version: 1, students: [
  { id: 'z1', name: 'Zoe', faces: [V1, 'x', [1, null], [], null] },
  { id: 'z2', name: 'Yan', faces: 'not a list' },
  { id: 'z3', name: 'Bo', profile: { id: 'z3', sessions: [{ id: 5, validMs: 'x' }, sess(9000)] } },
] });
check('junk faces dropped', S.faceVectors('z1'), [V1]);
check('non-list faces mean no bank', S.faceVectors('z2'), []);
check('three rows added', r.added, 3);
check('trustworthy session kept, hole dropped', S.loadProfile('z3').sessionCount(), 1);
check('counted one session', r.sessions, 1);

// The cap the phone applies: 40 newest sessions survive a merge, oldest go.
mem.clear();
r = S.importBundle({ kind: 'focuschange.pc.roster', version: 1, students: [{
  id: 'cap', name: 'Cap Test', profile: { id: 'cap', name: 'Cap Test',
    sessions: Array.from({ length: 45 }, (_, i) => sess(1000 + i)) },
}] });
const prof = S.loadProfile('cap');
check('capped at 40', prof.sessionCount(), 40);
check('the newest 40 survived', prof.sessions[prof.sessions.length - 1].id, 1044);
check('the oldest 5 were the ones lost', prof.sessions[0].id, 1005);

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
