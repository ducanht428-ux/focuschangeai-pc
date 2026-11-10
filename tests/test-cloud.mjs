// Field-name parity between the web leg's cloud payload and the camera's firestore_writer.
//
// The whole point of the shared store is that a teacher's query reads one child's rows from a phone, a
// camera and this page with no special case. That only holds if the web leg emits exactly the camera's
// column names, the camera's "not measured is a missing column, never a 0" rule, and the camera's
// rounding. These tests pin all three against build_session_payload in firestore_writer.py.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// The transport is the real Firestore REST API; the tests must never touch the network, so fetch is
// a recorder whose reply we flip between "store unreachable" and "store answered".
const calls = [];
let reply = { ok: false };
globalThis.fetch = async (url, opts) => {
  calls.push({ url, opts });
  if (!reply.ok) return { ok: false, headers: { get: () => null } };
  return {
    ok: true,
    headers: { get: (h) => (h === 'content-type' ? 'application/json; charset=UTF-8' : null) },
    json: async () => reply.json,
  };
};

const { summaryFromJson } = await import('../dist/js/habit.mjs');
const C = await import('../dist/js/cloud.mjs');

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(got));
};

// Only SEI measured: every other feature must stay absent, exactly as the camera leaves it absent.
const summary = summaryFromJson({
  id: 7, validMs: 600000, fr: 0.9123456789, vr: 0.78, q: 82.5,
  m: new Array(12).fill(0).map((_, i) => (i === 11 ? 74.0 : 0)),
  s: new Array(12).fill(0).map((_, i) => (i === 11 ? 8.5 : 0)),
  n: new Array(12).fill(0).map((_, i) => (i === 11 ? 96 : 0)),
  qn: 10, bi: 0, bb: 0, ba: 0, sl: 1,
});
const bands = [{ feature: 11, mean: 74.0, min: 61.0, max: 88.0, samples: 96, below: 3, above: 2 }];

const base = {
  studentId: 'hs1', studentName: 'Tran Van A', summary, bandOutcomes: bands,
  endedAtWallMs: 1762000000000, device: 'web-pc', appVersion: 'web',
};

// ---------------------------------------------------------------------------
check('doc key is -web- namespaced and sanitized',
  C.documentId('hs 1/x', 7), 'hs-1-x-web-7');

const p = C.buildSessionPayload(base);
check('exact camera column set', Object.keys(p).sort(), [
  'alerts_total', 'app_version', 'avg_fps', 'band_above_sei', 'band_below_sei', 'band_frames_sei',
  'band_k', 'band_max_sei', 'band_min_sei', 'band_typical_sei', 'csv_rows', 'device',
  'eligible', 'ended_at_wall_ms', 'face_ratio', 'false_alerts', 'mean_sei', 'n_sei', 'quality_mean',
  'schema', 'sensitivity', 'session_id', 'source', 'std_sei', 'student_id', 'student_name',
  'valid_ms', 'valid_ratio',
].sort());

check('source tag marks the instrument', p.source, 'web-pc');
check('schema', p.schema, 1);
check('eligible true when no reason', p.eligible, true);
check('csv_rows falls back to measured SEI frames', p.csv_rows, 96);
check('face_ratio rounded to 4 like the camera', p.face_ratio, 0.9123);
check('unmeasured features leave no zero column', 'mean_blink_bpm' in p, false);

// firestore_writer._round_to is floor(v*scale+0.5)/scale, not banker's rounding: 0.125 must go UP.
check('rounding matches Kotlin/Python, 0.125 -> 0.13',
  C.buildSessionPayload({ ...base, avgFps: 0.125 }).avg_fps, 0.13);

const refused = C.buildSessionPayload({ ...base, ineligibleReason: 'chưa đủ 10 phút hợp lệ' });
check('refused run carries eligible false + reason', [refused.eligible, refused.ineligible_reason],
  [false, 'chưa đủ 10 phút hợp lệ']);

const noBand = C.buildSessionPayload({ ...base, bandOutcomes: [] });
check('no band outcomes -> no band columns', 'band_k' in noBand, false);

// ---------------------------------------------------------------------------
// The queue: a failed upload must survive in localStorage, and a replaced doc must not duplicate.
C.queueSession({ doc: 'hs1-web-7', payload: p });
C.queueSession({ doc: 'hs1-web-7', payload: p });
check('same doc queues once, not twice', C.pendingCount(), 1);

await new Promise((r) => setTimeout(r, 30));
check('an unreachable store keeps the run queued', C.pendingCount(), 1);

reply = { ok: true, json: [] };
const drained = await C.flush();
check('flush drains once the store answers', [drained.sent, drained.left], [1, 0]);
check('nothing left behind', C.pendingCount(), 0);

const w = calls.find((c) => c.opts && c.opts.method === 'PATCH');
check('writes go to the shared sessions collection', w && w.url,
  'https://firestore.googleapis.com/v1/projects/focuschangedai/databases/(default)/documents/sessions/hs1-web-7');
const flds = JSON.parse(w.opts.body).fields;
check('strings encode as stringValue', flds.student_id, { stringValue: 'hs1' });
check('counts encode as integerValue strings', flds.valid_ms, { integerValue: '600000' });
check('fractions encode as doubleValue', flds.face_ratio, { doubleValue: 0.9123 });
check('flags encode as booleanValue', flds.eligible, { booleanValue: true });

reply = {
  ok: true,
  json: [{
    document: {
      name: 'projects/focuschangedai/databases/(default)/documents/sessions/hs1-web-7',
      fields: {
        student_id: { stringValue: 'hs1' },
        face_ratio: { doubleValue: 0.9123 },
        n_sei: { integerValue: '96' },
        eligible: { booleanValue: true },
      },
    },
  }],
};
const rows = await C.fetchSessions('hs1');
check('reads decode the shared rows back', rows,
  [{ student_id: 'hs1', face_ratio: 0.9123, n_sei: 96, eligible: true }]);
check('reads query by student_id',
  JSON.parse(calls[calls.length - 1].opts.body).structuredQuery.where.fieldFilter.value.stringValue,
  'hs1');

console.log(fails ? '\n' + fails + ' FAIL(S)' : '\nALL PASS');
process.exit(fails ? 1 : 0);
