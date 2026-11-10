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

const calls = [];
let reply = { ok: false, status: 503, json: { error: { message: 'UNAVAILABLE' } } };
let loginReply = { ok: true, json: {
  localId: 'test-member', email: 'member@example.test', idToken: 'test-id-token',
  refreshToken: 'test-refresh-token', expiresIn: '3600',
} };
let accessReply = { ok: true, json: [] };
let refreshReply = { ok: true, json: {
  user_id: 'test-member', id_token: 'test-refreshed-token', refresh_token: 'test-refresh-token-2', expires_in: '3600',
} };
let onPatch = null;
let onRefresh = null;
let offline = false;
globalThis.window = new EventTarget();
globalThis.fetch = async (url, opts) => {
  calls.push({ url, opts });
  if (offline) throw new TypeError('offline fixture');
  let answer = reply;
  if (url.includes('accounts:signInWithPassword')) answer = loginReply;
  else if (url.includes('securetoken.googleapis.com')) {
    if (onRefresh) await onRefresh();
    answer = refreshReply;
  } else if (url.endsWith(':runQuery') && JSON.parse(opts.body).structuredQuery.select) answer = accessReply;
  if (opts.method === 'PATCH' && onPatch) await onPatch();
  return { ok: answer.ok, status: answer.status || (answer.ok ? 200 : 503), json: async () => answer.json };
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
await C.queueSession({ doc: 'hs1-web-7', payload: p });
await C.queueSession({ doc: 'hs1-web-7', payload: p });
check('same doc queues once, not twice', C.pendingCount(), 1);

await C.flush();
check('signed-out recording stays queued', C.pendingCount(), 1);
check('signed-out recording makes no network call', calls.length, 0);
await C.fetchSessions('hs1').then(() => check('signed-out read rejected', false, true),
  () => check('signed-out read rejected', true, true));

const goodLogin = loginReply;
loginReply = { ok: false, status: 400, json: { error: { message: 'INVALID_LOGIN_CREDENTIALS' } } };
await C.signIn('member@example.test', 'fixture-only-password');
check('bad credentials leave user signed out', C.cloudState().user, null);
check('bad credentials show a safe error', C.cloudState().error, 'Email hoặc mật khẩu ứng dụng chưa đúng.');
loginReply = goodLogin;
accessReply = { ok: false, status: 403, json: { error: { message: 'PERMISSION_DENIED' } } };
await C.signIn('member@example.test', 'fixture-only-password');
check('nonmember has denied access', C.cloudState().access, 'denied');
check('nonmember cannot drain queue', (await C.flush()).left, 1);
check('nonmember sent no writes', calls.filter((c) => c.opts.method === 'PATCH').length, 0);
C.signOut();

accessReply = { ok: true, json: [] };
await C.signIn('member@example.test', 'fixture-only-password');
await C.flush();
check('member authenticated but unavailable write stays queued', C.pendingCount(), 1);
check('member public state exposes no tokens', Object.keys(C.cloudState().user).sort(), ['email', 'uid']);
check('no password or token in localStorage', /fixture-only-password|test-id-token|test-refresh-token/.test(JSON.stringify([...mem])), false);
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
check('writes carry ID token', w.opts.headers.Authorization, 'Bearer test-id-token');
check('reads carry ID token', calls.at(-1).opts.headers.Authorization, 'Bearer test-id-token');
check('all queries use the database documents root', calls.filter((c) => c.url.endsWith(':runQuery')).every((c) =>
  c.url === 'https://firestore.googleapis.com/v1/projects/focuschangedai/databases/(default)/documents:runQuery'), true);
check('query avoids an undeployed composite index',
  'orderBy' in JSON.parse(calls.at(-1).opts.body).structuredQuery, false);

onPatch = async () => {
  onPatch = null;
  await C.queueSession({ doc: 'hs2-web-8', payload: { ...p, student_id: 'hs2' } });
};
await C.queueSession({ doc: 'hs1-web-8', payload: p });
const job = C.flush();
check('overlapping flushes share one job', job === C.flush(), true);
check('new recording survives an in-flight PATCH', (await job).sent, 2);
check('concurrent queue drained both records', C.pendingCount(), 0);

onPatch = async () => {
  onPatch = null;
  await C.queueSession({ doc: 'hs1-web-9', payload: { ...p, mean_sei: 90 } });
};
await C.queueSession({ doc: 'hs1-web-9', payload: p });
check('a revised record is not removed by its older upload', (await C.flush()).sent, 2);
check('revised payload reached transport', JSON.parse(calls.at(-1).opts.body).fields.mean_sei, { integerValue: '90' });

offline = true;
await C.queueSession({ doc: 'hs1-web-10', payload: p });
await C.flush();
check('offline record is retained', C.pendingCount(), 1);
offline = false;
window.dispatchEvent(new Event('online'));
await new Promise((r) => setTimeout(r, 0));
await C.flush();
check('online event retries pending data', C.pendingCount(), 0);

const realNow = Date.now;
Date.now = () => realNow() + 3700000;
await Promise.all([C.fetchSessions('hs1'), C.fetchSessions('hs2')]);
check('concurrent expiry refreshes only once', calls.filter((c) => c.url.includes('securetoken.googleapis.com')).length, 1);
check('refreshed token used for Firestore', calls.at(-1).opts.headers.Authorization, 'Bearer test-refreshed-token');
Date.now = realNow;

onPatch = async () => { onPatch = null; C.signOut(); };
await C.queueSession({ doc: 'hs1-web-11', payload: p });
await C.flush();
check('logout during upload retains unacknowledged data', C.pendingCount(), 1);
check('logout clears user state', C.cloudState().user, null);
loginReply = { ok: true, json: { ...goodLogin.json, localId: 'other-member', email: 'other@example.test' } };
await C.signIn('other@example.test', 'fixture-only-password');
await C.flush();
check('different account cannot drain previous account queue', C.pendingCount(), 1);
offline = true;
await C.queueSession({ doc: 'hs1-web-11', payload: { ...p, mean_sei: 85 } });
await C.flush();
check('same document from another account does not discard previous pending data', C.pendingCount(), 2);
C.signOut();
offline = false;
loginReply = goodLogin;
await C.signIn('member@example.test', 'fixture-only-password');
await C.flush();
check('original account drains only its own record', C.pendingCount(), 1);
C.signOut();
loginReply = { ok: true, json: { ...goodLogin.json, localId: 'other-member', email: 'other@example.test' } };
await C.signIn('other@example.test', 'fixture-only-password');
await C.flush();
check('second account can drain its own record', C.pendingCount(), 0);
C.signOut();
loginReply = goodLogin;
await C.signIn('member@example.test', 'fixture-only-password');
await C.flush();

const C2 = await import('../dist/js/cloud.mjs?second-window');
await C2.signIn('member@example.test', 'fixture-only-password');
await C2.flush();
offline = true;
await C.queueSession({ doc: 'hs1-web-two-windows', payload: p });
await C.flush();
offline = false;
const beforeRace = calls.length;
let patchActive = 0;
let maxPatchActive = 0;
let revised = false;
onPatch = async () => {
  patchActive++;
  maxPatchActive = Math.max(maxPatchActive, patchActive);
  if (!revised) {
    revised = true;
    await C2.queueSession({ doc: 'hs1-web-two-windows', payload: { ...p, mean_sei: 91 } });
  }
  await new Promise((resolve) => setImmediate(resolve));
  patchActive--;
};
await Promise.all([C.flush(), C2.flush()]);
await C2.flush();
onPatch = null;
const raceWrites = calls.slice(beforeRace).filter((c) => c.opts.method === 'PATCH');
check('two windows never PATCH concurrently', maxPatchActive, 1);
check('two windows send each revision once', raceWrites.length, 2);
check('newest revision is the final server write', JSON.parse(raceWrites.at(-1).opts.body).fields.mean_sei, { integerValue: '91' });
check('two windows leave no pending revision', C.pendingCount(), 0);
C2.signOut();

reply = { ok: false, status: 403, json: { error: { message: 'PERMISSION_DENIED' } } };
await C.queueSession({ doc: 'hs1-web-12', payload: p });
await C.flush();
check('write denial retains queued data', C.pendingCount(), 1);
check('revoked permission is visible', C.cloudState().access, 'denied');
reply = { ok: true, json: [] };
await C.syncNow();
check('manual retry checks restored permissions', C.pendingCount(), 0);

Date.now = () => realNow() + 7400000;
refreshReply = { ok: false, status: 400, json: { error: { message: 'INVALID_REFRESH_TOKEN' } } };
await C.queueSession({ doc: 'hs1-web-13', payload: p });
await C.flush();
check('invalid refresh signs out', C.cloudState().user, null);
check('invalid refresh preserves pending record', C.pendingCount(), 1);
check('invalid refresh tells user to sign in again', C.cloudState().error.includes('đăng nhập lại'), true);
Date.now = realNow;

C.signOut();
refreshReply = { ok: true, json: { user_id: 'test-member', id_token: 'late-token', refresh_token: 'late-refresh', expires_in: '3600' } };
await C.signIn('member@example.test', 'fixture-only-password');
await C.flush();
Date.now = () => realNow() + 7400000;
onRefresh = async () => { onRefresh = null; C.signOut(); };
await C.fetchSessions('hs1').catch(() => {});
check('late refresh cannot restore a signed-out session', C.cloudState().user, null);
check('late token not used in Firestore', calls.some((c) => c.opts.headers?.Authorization === 'Bearer late-token'), false);
Date.now = realNow;
const fullQueue = Array.from({ length: 50 }, (_, i) => ({ doc: 'limit-' + i, payload: p, uid: 'test-member' }));
mem.set('focuschange_pc_pending_upload', JSON.stringify(fullQueue));
await C.queueSession({ doc: 'limit-overflow', payload: p });
check('full queue never silently evicts another record', JSON.parse(mem.get('focuschange_pc_pending_upload')), fullQueue);
check('queue-full warning is visible', C.cloudState().error.includes('đủ 50 phiên'), true);
check('only queue is persisted', [...mem.keys()], ['focuschange_pc_pending_upload']);

console.log(fails ? '\n' + fails + ' FAIL(S)' : '\nALL PASS');
process.exit(fails ? 1 : 0);
