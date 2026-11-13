// The ten-table SQLite writer (js/sqlstore.mjs), held against the Python leg it must agree with.
//
// Three kinds of proof here:
//   * schema parity - the SCHEMA string and the sqlite_master dump are compared against
//     database/focuschange_db.py itself, so a drift on either side fails this suite;
//   * write rules - the local_store.py semantics (named-only rows, replace-not-duplicate, owned
//     memberships, n>0 features, round half away from zero, baseline history);
//   * cross-read - the exported bytes are opened by Python's own sqlite3, integrity and foreign
//     keys checked, because "the web wrote a database" only means something if the camera leg's
//     reader can read it.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('../dist/sqljs/sql-wasm.js');
const SQL = await initSqlJs({
  locateFile: (f) => fileURLToPath(new URL('../dist/sqljs/' + f, import.meta.url)),
});

const { SqlStore, SCHEMA, TABLES, roundTo, dayOf } = await import('../dist/js/sqlstore.mjs');
const { HabitSession, HabitProfile, HF, HF_BAND_FEATURES, HF_KEYS } = await import('../dist/js/habit.mjs');
const { MonitorSession } = await import('../dist/js/session.mjs');

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(got));
};

const PY_REPO = 'C:/Users/Admin/AndroidStudioProjects/FocusChangeAIApp';
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// 1. Schema parity, text level: the JS string must BE the Python string.
let pySchema = null;
try {
  const py = readFileSync(PY_REPO + '/database/focuschange_db.py', 'utf8');
  const m = py.match(/SCHEMA = """([\s\S]*?)"""/);
  pySchema = m ? m[1] : null;
} catch (e) { /* the Python checkout is absent on this machine */ }
if (pySchema !== null) {
  check('SCHEMA text matches focuschange_db.py', norm(SCHEMA), norm(pySchema));
} else {
  console.log('SKIP schema text parity (no Python checkout at ' + PY_REPO + ')');
}

// 2. Schema parity, engine level: sqlite_master from both engines, statement by statement.
const PY_DUMP = [
  'import json, sqlite3, sys',
  'sys.path.insert(0, "' + PY_REPO + '")',
  'from database import focuschange_db as s',
  'c = sqlite3.connect(":memory:")',
  'c.executescript(s.SCHEMA)',
  'rows = c.execute("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").fetchall()',
  'print(json.dumps([list(r) for r in rows]))',
].join('\n');

function masterOf(db) {
  const stmt = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push([r.type, r.name, r.tbl_name, r.sql === null ? null : norm(r.sql)]);
  }
  stmt.free();
  return rows;
}

const fresh = () => new SQL.Database();
let db = fresh();
let store = new SqlStore(db, { source: 'pc-web', appVersion: 'test-build' });
check('store opens', store.enabled, true);
check('ten tables', Object.keys(store.counts()).length, 10);
check('empty at birth', Object.values(store.counts()).every((n) => n === 0), true);

const pyDump = spawnSync('python', ['-c', PY_DUMP], { encoding: 'utf8' });
if (pyDump.status === 0) {
  const pyMaster = JSON.parse(pyDump.stdout).map((r) => [r[0], r[1], r[2], r[3] === null ? null : norm(r[3])]);
  check('sqlite_master matches the Python engine', masterOf(db), pyMaster);
} else {
  console.log('SKIP sqlite_master parity (python unavailable: ' + (pyDump.stderr || '').slice(0, 120) + ')');
}

// ---------------------------------------------------------------------------
// 3. One eligible named session, built the way the page builds it.
const noon = (d) => new Date(2026, 10, d, 12, 0, 0).getTime();
const DAY1 = noon(9);
const DAY2 = noon(10);

function mkSession(id, { minutes = 3, sei = 70, features = null } = {}) {
  const s = new HabitSession(id);
  s.sensitivityLevel = 1;
  let t = id;
  s.tick(t, true, true);
  // 500 ms steps: a tick wider than MAX_FRAME_GAP_MS (700) is a stall, not valid time.
  for (let i = 0; i < minutes * 120; i++) { t += 500; s.tick(t, true, true); }
  const vals = { [HF.BPM]: 15, [HF.BLINK_MS]: 120, [HF.DIST]: 55, [HF.YAW]: 2, [HF.PITCH]: 1,
    [HF.GAZE_H]: 0.1, [HF.GAZE_V]: 0.05, [HF.MAR]: 0.3, [HF.BFR]: 0.2, [HF.EAR]: 0.3,
    [HF.PERCLOS]: 10, [HF.SEI]: sei };
  for (let i = 0; i < 40; i++) {
    for (const f of features || Object.keys(vals).map(Number)) s.observe(f, vals[f]);
  }
  for (let i = 0; i < 10; i++) s.addQuality(80);
  return s;
}

const s1 = mkSession(DAY1);
const sum1 = s1.toSummary();
const p1 = new HabitProfile('hs-a', 'Trần Văn A');
check('session is eligible', p1.ineligibleReason(sum1), null);
p1.commit(sum1);

const ok1 = store.writeSession({
  studentId: 'hs-a', studentName: 'Trần Văn A', summary: sum1, bandOutcomes: [],
  endedAtWallMs: DAY1 + 200000, device: 'Win32', ineligibleReason: null, identity: 'manual',
});
check('write lands', ok1, true);
let c = store.counts();
check('one session row', c.observation_sessions, 1);
check('one student row', c.students, 1);
check('one class row', c.classes, 1);
check('one membership row', c.class_memberships, 1);
check('twelve feature rows (all observed)', c.feature_records, 12);
check('no alert rows (this leg never tallies)', c.alerts, 0);
check('sent counter', store.sent, 1);

function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

let row = rows('SELECT * FROM observation_sessions')[0];
check('source column', row.source, 'pc-web');
check('started_at is the session id', row.started_at_wall_ms, DAY1);
check('valid_ms carried', row.valid_ms, sum1.validMs);
check('app_version carried', row.app_version, 'test-build');
let meta = JSON.parse(row.notes);
check('meta face_ratio', meta.face_ratio, 1);
check('meta valid_ratio', meta.valid_ratio, 1);
check('meta eligible', meta.eligible, true);
check('meta identity', meta.identity, 'manual');
check('meta quality_mean', meta.quality_mean, 80);
check('meta sensitivity', meta.sensitivity, 1);
check('meta has no invented alert count', 'alerts_total' in meta, false);
check('meta has no invented fps', 'avg_fps' in meta, false);
check('membership note is the source', rows('SELECT note FROM class_memberships')[0].note, 'pc-web');
check('membership started_on', rows('SELECT started_on FROM class_memberships')[0].started_on, dayOf(DAY1));
check('feature extractor', rows('SELECT DISTINCT extractor FROM feature_records')[0].extractor, 'mediapipe');
check('feature n', rows('SELECT n FROM feature_records WHERE feature = ?', ['sei'])[0].n, 40);
check('feature mean rounded', rows('SELECT mean FROM feature_records WHERE feature = ?', ['sei'])[0].mean, 70);

// ---------------------------------------------------------------------------
// 4. An ineligible run is still a record - with eligible:false and the reason, never silently dropped.
const short = mkSession(DAY1 + 3600000, { minutes: 1 });
const sumShort = short.toSummary();
const reason = p1.ineligibleReason(sumShort);
check('short run refused by the profile', reason !== null, true);
const okShort = store.writeSession({
  studentId: 'hs-a', studentName: 'Trần Văn A', summary: sumShort, bandOutcomes: [],
  endedAtWallMs: DAY1 + 3600000 + 70000, device: 'Win32', ineligibleReason: reason, identity: 'manual',
});
check('ineligible run still lands', okShort, true);
row = rows('SELECT * FROM observation_sessions WHERE started_at_wall_ms = ?', [DAY1 + 3600000])[0];
meta = JSON.parse(row.notes);
check('ineligible meta eligible=false', meta.eligible, false);
check('ineligible meta carries the reason', meta.ineligible_reason, reason);
check('profile did not learn it', p1.sessionCount(), 1);

// ---------------------------------------------------------------------------
// 5. Replace, not duplicate: committing the same session twice keeps one row and one set of features.
store.writeSession({
  studentId: 'hs-a', studentName: 'Trần Văn A', summary: sum1, bandOutcomes: [],
  endedAtWallMs: DAY1 + 210000, device: 'Win32', ineligibleReason: null, identity: 'manual',
});
c = store.counts();
check('same session id still one row', c.observation_sessions, 2); // the eligible one + the short one
check('features did not double', c.feature_records, 12 + 12);
check('the replaced row kept the later end', rows(
  'SELECT ended_at_wall_ms FROM observation_sessions WHERE started_at_wall_ms = ?', [DAY1])[0].ended_at_wall_ms, DAY1 + 210000);

// ---------------------------------------------------------------------------
// 6. Memberships: same day adds nothing, a human register is never fought, an own old row is closed.
store.writeSession({
  studentId: 'hs-a', studentName: 'Trần Văn A', summary: mkSession(DAY1 + 7200000).toSummary(),
  bandOutcomes: [], endedAtWallMs: DAY1 + 7400000, device: 'Win32', ineligibleReason: null, identity: 'face',
});
check('same-day session opens no second membership', store.counts().class_memberships, 1);

db.run('INSERT INTO students (student_id, name, created_at_ms) VALUES (?, ?, ?)', ['hs-b', 'Lê Thị B', DAY1]);
db.run('INSERT INTO class_memberships (student_id, class_id, school_year, started_on, note)'
  + ' VALUES (?, ?, ?, ?, ?)', ['hs-b', 'lop12a', '2026-2027', dayOf(DAY1), 'registrar']);
store.writeSession({
  studentId: 'hs-b', studentName: 'Lê Thị B', summary: mkSession(DAY1 + 9000000).toSummary(),
  bandOutcomes: [], endedAtWallMs: DAY1 + 9200000, device: 'Win32', ineligibleReason: null, identity: 'face',
});
const bMembers = rows('SELECT * FROM class_memberships WHERE student_id = ?', ['hs-b']);
check('human-owned membership untouched', bMembers.length, 1);
check('human note kept', bMembers[0].note, 'registrar');
check('no camera row forced in', bMembers[0].ended_on, null);

// A transfer closes the camera's own old-class row and opens a fresh one in the new class. (A new
// day alone does not: an open row in the SAME class is "already recorded here", same as Python.)
db.run('INSERT OR IGNORE INTO classes (class_id, name, school_year, created_at_ms) VALUES (?, ?, ?, ?)',
  ['lop12b', 'Lớp 12B', '2026-2027', DAY1]);
db.run('UPDATE class_memberships SET class_id = ? WHERE student_id = ? AND ended_on IS NULL',
  ['lop12b', 'hs-a']);
store.writeSession({
  studentId: 'hs-a', studentName: 'Trần Văn A', summary: mkSession(DAY2).toSummary(),
  bandOutcomes: [], endedAtWallMs: DAY2 + 200000, device: 'Win32', ineligibleReason: null, identity: 'manual',
});
const aMembers = rows('SELECT * FROM class_memberships WHERE student_id = ? ORDER BY membership_id', ['hs-a']);
check('own old row closed on transfer', aMembers.length, 2);
check('closed row is the old class', aMembers[0].class_id, 'lop12b');
check('closed row ended_on = today', aMembers[0].ended_on, dayOf(DAY2));
check('new row open', aMembers[1].ended_on, null);
check('new row started today', aMembers[1].started_on, dayOf(DAY2));
check('new row is the current class', aMembers[1].class_id, 'lop12a');

// Falsification: the overlap trigger must refuse a second open period, whoever writes it.
let triggerFired = false;
try {
  db.run('INSERT INTO class_memberships (student_id, class_id, school_year, started_on, note)'
    + ' VALUES (?, ?, ?, ?, ?)', ['hs-a', 'lop12a', '2026-2027', dayOf(DAY2), 'pc-web']);
} catch (e) {
  triggerFired = /overlapping class membership/.test(String(e.message || e));
}
check('overlap trigger fires', triggerFired, true);

// ---------------------------------------------------------------------------
// 7. Rounding is the phone's formula, not Math.round and not banker's.
check('0.125 -> 0.13', roundTo(0.125, 100), 0.13);
check('-0.125 -> -0.12 (floor(v*s+0.5), same as Python)', roundTo(-0.125, 100), -0.12);
check('NaN -> 0', roundTo(NaN, 100), 0);
check('Infinity -> 0', roundTo(Infinity, 100), 0);
check('null -> 0', roundTo(null, 100), 0);
check('four decimals', roundTo(0.12345, 10000), 0.1235);

// ---------------------------------------------------------------------------
// 8. Bands: meta on the session row, history in baseline_profiles.
const s2 = mkSession(DAY2 + 3600000);
s2.setBands(p1.baseline(), HF_BAND_FEATURES);
for (const f of HF_BAND_FEATURES) { s2.observeBand(f, 15); s2.observeBand(f, 15); }
const sum2 = s2.toSummary();
p1.commit(sum2);
store.writeSession({
  studentId: 'hs-a', studentName: 'Trần Văn A', summary: sum2, bandOutcomes: s2.bandOutcomes(),
  endedAtWallMs: DAY2 + 3800000, device: 'Win32', ineligibleReason: null, identity: 'manual',
});
row = rows('SELECT notes FROM observation_sessions WHERE started_at_wall_ms = ?', [DAY2 + 3600000])[0];
meta = JSON.parse(row.notes);
check('band_k in meta', meta.band_k, 2.5);
check('band_frames in meta', meta.band_frames, sum2.bandIn + sum2.bandBelow + sum2.bandAbove);
check('band_sei object in meta', typeof meta.band_sei, 'object');
check('band_sei frames', meta.band_sei.frames, 2);

const okBand = store.writeBand({ studentId: 'hs-a', studentName: 'Trần Văn A', profile: p1,
  updatedAtWallMs: DAY2 + 3800000, device: 'Win32' });
check('band snapshot lands', okBand, true);
let base = rows('SELECT * FROM baseline_profiles ORDER BY baseline_id DESC')[0];
check('baseline status building (2 sessions)', base.status, 'building');
check('baseline sessions_used', base.sessions_used, 2);
check('baseline window_start is the first session', base.window_start_ms, DAY1);
check('baseline days', base.days, 2);
const fj = JSON.parse(base.features_json);
check('features_json band_k', fj.band_k, 2.5);
check('features_json source', fj.source, 'pc-web');
check('features_json has sei band', typeof fj.features.sei, 'object');
check('sei band keys', Object.keys(fj.features.sei).sort(), ['max', 'min', 'spread', 'typical']);

// A ready profile says ready; an empty one writes nothing.
const pReady = new HabitProfile('hs-ready', 'Đủ Chuẩn');
for (let i = 0; i < 5; i++) pReady.commit(mkSession(DAY1 + i * 86400000, { minutes: 3 }).toSummary());
check('ready profile is ready', pReady.isReady(), true);
store.writeBand({ studentId: 'hs-ready', studentName: 'Đủ Chuẩn', profile: pReady,
  updatedAtWallMs: DAY1 + 5 * 86400000, device: 'Win32' });
base = rows('SELECT status FROM baseline_profiles WHERE student_id = ?', ['hs-ready'])[0];
check('ready status', base.status, 'ready');
const empty = new HabitProfile('hs-empty', 'Chưa Có Gì');
check('empty profile writes no baseline', store.writeBand({ studentId: 'hs-empty',
  studentName: 'Chưa Có Gì', profile: empty, updatedAtWallMs: DAY1, device: 'Win32' }), false);

// ---------------------------------------------------------------------------
// 9. A refused write rolls the WHOLE session back - no orphan student, no half row.
const bad = mkSession(DAY2 + 9000000);
const badSum = bad.toSummary();
badSum.validMs = -5; // CHECK valid_ms >= 0 must refuse this
const before = store.counts();
const okBad = store.writeSession({ studentId: 'hs-bad', studentName: 'Âm Lịch', summary: badSum,
  bandOutcomes: [], endedAtWallMs: DAY2 + 9200000, device: 'Win32', ineligibleReason: null, identity: 'manual' });
check('bad write refused', okBad, false);
check('failed counter moved', store.failed, 1);
check('nothing partial survived', store.counts(), before);
check('lastError names the session', /hs-bad/.test(store.lastError), true);

// ---------------------------------------------------------------------------
// 10. Round-trip: export -> reimport keeps every row; Python's own sqlite3 reads the file.
const bytes = store.exportBytes();
const db2 = new SQL.Database(bytes);
const store2 = new SqlStore(db2, { source: 'pc-web' });
check('reimported counts match', store2.counts(), store.counts());
check('reimported store still enabled', store2.enabled, true);

const tmp = join(tmpdir(), 'fc-sqlstore-test-' + Date.now() + '.db');
writeFileSync(tmp, Buffer.from(bytes));
const PY_READ = [
  'import json, sqlite3, sys',
  'sys.path.insert(0, "' + PY_REPO + '")',
  'from database import focuschange_db as s',
  'c = sqlite3.connect(sys.argv[1])',
  'counts = {t: c.execute(\'SELECT COUNT(*) FROM "\' + t + \'"\').fetchone()[0] for t in s.TABLES}',
  'print(json.dumps({"counts": counts,',
  '  "integrity": c.execute("PRAGMA integrity_check").fetchone()[0],',
  '  "fk": len(c.execute("PRAGMA foreign_key_check").fetchall())}))',
].join('\n');
const pyRead = spawnSync('python', ['-c', PY_READ, tmp], { encoding: 'utf8' });
if (pyRead.status === 0) {
  const r = JSON.parse(pyRead.stdout);
  check('Python reads the web-written file: counts', r.counts, store.counts());
  check('Python integrity_check', r.integrity, 'ok');
  check('Python foreign_key_check', r.fk, 0);
} else {
  console.log('SKIP Python cross-read (python unavailable: ' + (pyRead.stderr || '').slice(0, 120) + ')');
}
unlinkSync(tmp);

// ---------------------------------------------------------------------------
// 11. The session layer carries bandOutcomes through both commit calls.
const ms = new MonitorSession();
const pm = new HabitProfile('hs-m', 'Em M');
ms.setProfile(pm);
ms.startHabitSession();
let tm = Date.now();
ms.habitSession.tick(tm, true, true);
for (let i = 0; i < 360; i++) { tm += 500; ms.habitSession.tick(tm, true, true); }
for (let i = 0; i < 40; i++) ms.habitSession.observe(HF.SEI, 70);
const outSave = ms.saveHabitSession();
check('saveHabitSession returns bandOutcomes array', Array.isArray(outSave.bandOutcomes), true);
check('saveHabitSession keeps the summary', typeof outSave.summary.validMs, 'number');
const outEnd = ms.endHabitSession();
check('endHabitSession returns bandOutcomes array', Array.isArray(outEnd.bandOutcomes), true);
check('endHabitSession closed the accumulator', ms.habitSession, null);

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);