// The ten-table SQLite database, web leg - the same file the Python camera leg writes.
//
// Ported from two places, and the port is the point:
//   * database/focuschange_db.py  -> SCHEMA below, verbatim. One schema, three instruments: a row
//     written here must satisfy exactly the CHECKs and triggers the phone-side document describes.
//   * edge-server/focusedge/local_store.py -> SqlStore, rule for rule: INSERT OR IGNORE students,
//     memberships owned by note, replace-before-insert sessions, features only when n > 0, baseline
//     history with the learned bands, round half away from zero.
//
// The engine is sql.js (SQLite compiled to WASM, vendored in dist/sqljs/). This module never loads it
// and never touches a browser API: it is handed a sql.js Database and stays pure, so the Node suite
// can replay the same writes against the same schema the Python tests use.
//
// What this leg does NOT write, on purpose: alert rows and the alerts_total / false_alerts / csv_rows
// / avg_fps meta keys. The page shows alert sentences but never tallies them (no counter exists in
// index.html), and a missing measurement is an absent key, not a zero - writing 0 would claim "no
// alerts happened" about a run nobody counted. The Python leg counts, so its rows carry the numbers.

import { HF_KEYS, HF_BAND_FEATURES, HC } from './habit.mjs';

export const TABLES = [
  'classes', 'students', 'class_memberships', 'observation_sessions', 'baseline_profiles',
  'feature_records', 'ai_results', 'alerts', 'review_records', 'sync_history',
];

// Same default the camera's config.yaml carries, so a web row and a camera row land in one class.
export const DEFAULT_SCHOOL_YEAR = '2026-2027';

// Verbatim from database/focuschange_db.py (SCHEMA). Do not "improve" it here: the parity test
// compares this string against the Python module's own, statement by statement.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS classes (
    class_id       TEXT PRIMARY KEY NOT NULL CHECK (length(trim(class_id)) > 0),
    name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
    school_year    TEXT NOT NULL CHECK (length(trim(school_year)) > 0),
    grade          TEXT,
    created_at_ms  INTEGER NOT NULL,
    UNIQUE (class_id, school_year)
);

CREATE TABLE IF NOT EXISTS students (
    student_id     TEXT PRIMARY KEY NOT NULL CHECK (length(trim(student_id)) > 0),
    name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
    birth_year     INTEGER,
    gender         TEXT,
    notes          TEXT,
    created_at_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS class_memberships (
    membership_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id     TEXT NOT NULL REFERENCES students(student_id),
    class_id       TEXT NOT NULL,
    school_year    TEXT NOT NULL,
    started_on     TEXT NOT NULL CHECK (
        length(started_on) = 10 AND date(started_on, '+0 days') IS started_on),
    ended_on       TEXT CHECK (ended_on IS NULL OR (
        length(ended_on) = 10 AND date(ended_on, '+0 days') IS ended_on
        AND ended_on > started_on)),
    note           TEXT,
    FOREIGN KEY (class_id, school_year) REFERENCES classes(class_id, school_year),
    UNIQUE (student_id, started_on)
);

-- Membership periods are [started_on, ended_on), allowing transfer on the end date.
CREATE TRIGGER IF NOT EXISTS membership_no_overlap_insert
BEFORE INSERT ON class_memberships
WHEN EXISTS (
    SELECT 1 FROM class_memberships AS m
    WHERE m.student_id = NEW.student_id
      AND (NEW.ended_on IS NULL OR m.started_on < NEW.ended_on)
      AND (m.ended_on IS NULL OR NEW.started_on < m.ended_on)
)
BEGIN
    SELECT RAISE(ABORT, 'overlapping class membership');
END;

CREATE TRIGGER IF NOT EXISTS membership_no_overlap_update
BEFORE UPDATE ON class_memberships
WHEN EXISTS (
    SELECT 1 FROM class_memberships AS m
    WHERE m.student_id = NEW.student_id AND m.membership_id != OLD.membership_id
      AND (NEW.ended_on IS NULL OR m.started_on < NEW.ended_on)
      AND (m.ended_on IS NULL OR NEW.started_on < m.ended_on)
)
BEGIN
    SELECT RAISE(ABORT, 'overlapping class membership');
END;

CREATE TABLE IF NOT EXISTS observation_sessions (
    session_row        INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id         TEXT NOT NULL REFERENCES students(student_id),
    class_id           TEXT REFERENCES classes(class_id),
    source             TEXT NOT NULL DEFAULT 'edge-camera',
    started_at_wall_ms INTEGER,
    ended_at_wall_ms   INTEGER NOT NULL,
    valid_ms           INTEGER NOT NULL DEFAULT 0 CHECK (valid_ms >= 0),
    device             TEXT NOT NULL DEFAULT '',
    app_version        TEXT NOT NULL DEFAULT '',
    notes              TEXT,
    CHECK (started_at_wall_ms IS NULL OR ended_at_wall_ms >= started_at_wall_ms),
    UNIQUE (session_row, student_id)
);

CREATE TABLE IF NOT EXISTS baseline_profiles (
    baseline_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT NOT NULL REFERENCES students(student_id),
    window_start_ms INTEGER NOT NULL,
    window_end_ms   INTEGER NOT NULL CHECK (window_end_ms >= window_start_ms),
    days            INTEGER NOT NULL DEFAULT 14 CHECK (days > 0),
    sessions_used   INTEGER NOT NULL DEFAULT 0 CHECK (sessions_used >= 0),
    status          TEXT NOT NULL DEFAULT 'building',
    features_json   TEXT NOT NULL DEFAULT '{}' CHECK (
        CASE WHEN json_valid(features_json) THEN json_type(features_json) = 'object' ELSE 0 END),
    created_at_ms   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_records (
    feature_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    session_row  INTEGER NOT NULL REFERENCES observation_sessions(session_row) ON DELETE CASCADE,
    feature      TEXT NOT NULL CHECK (length(trim(feature)) > 0),
    mean         REAL NOT NULL,
    std          REAL NOT NULL CHECK (std >= 0),
    n            INTEGER NOT NULL CHECK (n > 0),
    extractor    TEXT NOT NULL DEFAULT 'mediapipe',
    UNIQUE (session_row, extractor, feature)
);

CREATE TABLE IF NOT EXISTS ai_results (
    result_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    session_row    INTEGER NOT NULL REFERENCES observation_sessions(session_row) ON DELETE CASCADE,
    sei_mean       REAL CHECK (sei_mean IS NULL OR sei_mean BETWEEN 0 AND 100),
    label          TEXT,
    explanation    TEXT,
    model_version  TEXT NOT NULL DEFAULT '',
    created_at_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
    alert_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_row       INTEGER NOT NULL,
    student_id        TEXT NOT NULL,
    kind              TEXT NOT NULL,
    message           TEXT NOT NULL,
    raised_at_wall_ms INTEGER NOT NULL,
    status            TEXT NOT NULL DEFAULT 'new',
    FOREIGN KEY (session_row, student_id)
        REFERENCES observation_sessions(session_row, student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_records (
    review_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id       INTEGER NOT NULL REFERENCES alerts(alert_id) ON DELETE CASCADE,
    reviewer       TEXT NOT NULL CHECK (length(trim(reviewer)) > 0),
    verdict        TEXT NOT NULL,
    comment        TEXT,
    reviewed_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_history (
    sync_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    direction     TEXT NOT NULL,
    target        TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,
    rows_synced   INTEGER NOT NULL DEFAULT 0 CHECK (rows_synced >= 0),
    started_at_ms INTEGER NOT NULL,
    detail        TEXT
);

CREATE INDEX IF NOT EXISTS sessions_by_student
    ON observation_sessions(student_id, ended_at_wall_ms);
CREATE INDEX IF NOT EXISTS baselines_by_student
    ON baseline_profiles(student_id, window_end_ms);
CREATE INDEX IF NOT EXISTS results_by_session ON ai_results(session_row);
CREATE INDEX IF NOT EXISTS alerts_by_session ON alerts(session_row, student_id);
CREATE INDEX IF NOT EXISTS reviews_by_alert ON review_records(alert_id);
`;

/** Round half away from zero - the phone's rule (FirebaseSync.kt:944), same as local_store._round_to.
 * Math.round is NOT it: JS rounds -0.125 toward +Infinity, and non-finite values must land on 0.0. */
export function roundTo(v, scale) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0.0;
  return Math.floor(v * scale + 0.5) / scale;
}
const round2 = (v) => roundTo(v, 100.0);
const round4 = (v) => roundTo(v, 10000.0);

/** Local-calendar day of a wall-clock ms, the same answer time.localtime gives the Python leg. */
export function dayOf(wallMs) {
  const d = new Date(wallMs);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// sql.js helpers. prepare/bind/step is used for every parameterised read because exec() with params
// is a newer convenience; run() handles multi-statement strings (the schema) and writes.
function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function run(db, sql, params = []) { db.run(sql, params); }
function lastId(db) { return all(db, 'SELECT last_insert_rowid() AS id')[0].id; }

/**
 * LocalStore's write rules on a sql.js Database. One instance owns one open database; the caller
 * (index.html) decides where the bytes live - userData/focuschange.db in the app, IndexedDB in a tab.
 *
 * A refused write costs the run its record, never its measurement: every public write is guarded,
 * failures move `failed` and `lastError`, and the page keeps scoring either way.
 */
export class SqlStore {
  constructor(db, opts = {}) {
    this.db = db;
    this.classId = opts.classId || 'lop12a';
    this.classLabel = opts.classLabel || 'Lớp học';
    this.schoolYear = opts.schoolYear || DEFAULT_SCHOOL_YEAR;
    this.appVersion = opts.appVersion || '';
    // Which instrument filled a row: 'pc-app' (installed) or 'pc-web' (browser tab). The camera leg
    // writes 'edge-camera'; the column is the only place the three are told apart.
    this.source = opts.source || 'pc-web';
    this.sent = 0;
    this.failed = 0;
    this.lastError = '';
    this.enabled = false;
    try {
      db.run('PRAGMA foreign_keys = ON');
      db.run(SCHEMA);
      this.enabled = true;
    } catch (e) {
      this.lastError = String((e && e.message) || e);
    }
  }

  _fail(what, e) {
    this.failed += 1;
    this.lastError = what + ': ' + String((e && e.message) || e);
  }

  /** One measured session: its row, its per-feature statistics. Returns true when it landed. */
  writeSession({ studentId, studentName, summary, bandOutcomes = [], endedAtWallMs,
    device = '', ineligibleReason = null, identity = null }) {
    if (!this.enabled) return false;
    const s = summary;
    try {
      run(this.db, 'BEGIN');
      this._ensureStudent(studentId, studentName);
      this._ensureMembership(studentId, endedAtWallMs, dayOf(s.id));
      this._replaceSession(studentId, s.id);
      const row = this._insertSession(studentId, s, endedAtWallMs, device, ineligibleReason,
        bandOutcomes, identity);
      this._insertFeatures(row, s);
      run(this.db, 'COMMIT');
      this.sent += 1;
      return true;
    } catch (e) {
      try { run(this.db, 'ROLLBACK'); } catch (e2) { /* already rolled back */ }
      this._fail('session ' + studentId + '/' + s.id, e);
      return false;
    }
  }

  /** Append one baseline snapshot: the bands the profile has learned as of this session. */
  writeBand({ studentId, studentName, profile, updatedAtWallMs, device = '' }) {
    if (!this.enabled) return false;
    const base = profile.baseline();
    const features = {};
    for (const f of HF_BAND_FEATURES) {
      const b = base.band(f);
      if (b === null) continue;
      features[HF_KEYS[f]] = {
        typical: round2(b.mean), min: round2(b.min), max: round2(b.max),
        spread: round2(base.spread(f) || 0.0),
      };
    }
    if (Object.keys(features).length === 0) return false;
    const starts = profile.sessions.length ? profile.sessions.map((x) => x.id) : [updatedAtWallMs];
    const windowStart = Math.min(...starts);
    const days = Math.max(1, Math.ceil((updatedAtWallMs - windowStart) / 86400000.0));
    try {
      run(this.db, 'BEGIN');
      this._ensureStudent(studentId, studentName);
      run(this.db,
        'INSERT INTO baseline_profiles (student_id, window_start_ms, window_end_ms, days,'
        + ' sessions_used, status, features_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [studentId, windowStart, updatedAtWallMs, days, profile.sessionCount(),
          profile.isReady() ? 'ready' : 'building',
          JSON.stringify({ band_k: HC.BAND_K, source: this.source, device, features }),
          updatedAtWallMs]);
      run(this.db, 'COMMIT');
      this.sent += 1;
      return true;
    } catch (e) {
      try { run(this.db, 'ROLLBACK'); } catch (e2) { /* already rolled back */ }
      this._fail('baseline ' + studentId, e);
      return false;
    }
  }

  _ensureStudent(studentId, studentName) {
    // INSERT OR IGNORE, not an upsert of the name: students also carries birth_year and gender,
    // filled in by whoever maintains the roster. Re-writing the row would flatten them.
    run(this.db, 'INSERT OR IGNORE INTO students (student_id, name, created_at_ms) VALUES (?, ?, ?)',
      [studentId, studentName || studentId, Date.now()]);
  }

  _ensureClass() {
    run(this.db,
      'INSERT OR IGNORE INTO classes (class_id, name, school_year, created_at_ms) VALUES (?, ?, ?, ?)',
      [this.classId, this.classLabel, this.schoolYear, Date.now()]);
  }

  _ensureMembership(studentId, nowWallMs, startedOn) {
    // The membership table is a school's enrolment register and this page is not the registrar: a row
    // is opened with note = source, and only a row this source opened is ever closed. A human-owned
    // open membership is left exactly as it is. Same three exits as local_store._ensure_membership.
    this._ensureClass();
    const rows = all(this.db,
      'SELECT membership_id, class_id, school_year, started_on, note FROM class_memberships'
      + ' WHERE student_id = ? AND ended_on IS NULL', [studentId]);
    for (const r of rows) {
      if (r.class_id === this.classId && r.school_year === this.schoolYear) return;
    }
    const today = dayOf(nowWallMs);
    for (const r of rows) {
      if (r.note !== this.source) return;
      if (r.started_on >= today) return;
      run(this.db, 'UPDATE class_memberships SET ended_on = ? WHERE membership_id = ?',
        [today, r.membership_id]);
      break;
    }
    run(this.db,
      'INSERT INTO class_memberships (student_id, class_id, school_year, started_on, note)'
      + ' VALUES (?, ?, ?, ?, ?)',
      [studentId, this.classId, this.schoolYear, startedOn, this.source]);
  }

  _insertSession(studentId, s, endedAtWallMs, device, ineligibleReason, bandOutcomes, identity) {
    const bandSamples = s.bandIn + s.bandBelow + s.bandAbove;
    const meta = {
      face_ratio: round4(s.faceRatio),
      valid_ratio: round4(s.validRatio),
      eligible: ineligibleReason === null || ineligibleReason === undefined,
    };
    if (identity) meta.identity = identity;
    if (ineligibleReason !== null && ineligibleReason !== undefined) {
      meta.ineligible_reason = ineligibleReason;
    }
    if (s.qualityCount > 0) meta.quality_mean = round2(s.quality);
    if (s.sensitivityLevel >= 0) meta.sensitivity = s.sensitivityLevel;
    if (bandSamples > 0) {
      meta.band_k = HC.BAND_K;
      meta.band_frames = bandSamples;
      meta.band_below = s.bandBelow;
      meta.band_above = s.bandAbove;
    }
    for (const b of bandOutcomes || []) {
      meta['band_' + HF_KEYS[b.feature]] = {
        min: round2(b.min), max: round2(b.max), typical: round2(b.mean),
        frames: b.samples, below: b.below, above: b.above,
      };
    }
    run(this.db,
      'INSERT INTO observation_sessions (student_id, class_id, source, started_at_wall_ms,'
      + ' ended_at_wall_ms, valid_ms, device, app_version, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [studentId, this.classId, this.source, s.id, endedAtWallMs, s.validMs, device,
        this.appVersion, JSON.stringify(meta)]);
    return lastId(this.db);
  }

  _replaceSession(studentId, sessionId) {
    // A second commit of one session replaces its record instead of doubling it - the cloud's set()
    // rule, applied by hand because started_at_wall_ms carries no unique key. The schema's cascades
    // clean up feature_records / ai_results / alerts with the row.
    const old = all(this.db,
      'SELECT session_row FROM observation_sessions WHERE student_id = ? AND source = ?'
      + ' AND started_at_wall_ms = ?', [studentId, this.source, sessionId]);
    if (old.length) {
      run(this.db, 'DELETE FROM observation_sessions WHERE session_row = ?', [old[0].session_row]);
    }
  }

  _insertFeatures(sessionRow, s) {
    // Only features with at least one observation: a number nobody measured is an absent row, not a
    // zero - the schema enforces it (CHECK n > 0).
    for (let f = 0; f < HF_KEYS.length; f++) {
      const n = s.count[f];
      if (n > 0) {
        run(this.db,
          'INSERT OR REPLACE INTO feature_records (session_row, feature, mean, std, n, extractor)'
          + ' VALUES (?, ?, ?, ?, ?, ?)',
          [sessionRow, HF_KEYS[f], round2(s.mean[f]), round2(s.std[f]), n, 'mediapipe']);
      }
    }
  }

  /** Row counts per table, for the status line. Never throws on a closed store. */
  counts() {
    const out = {};
    for (const t of TABLES) {
      out[t] = this.enabled ? all(this.db, 'SELECT COUNT(*) AS n FROM "' + t + '"')[0].n : 0;
    }
    return out;
  }

  /** Saved sessions, newest first, for the report picker. Joined to the student's name; the notes
   * column is the meta JSON _insertSession wrote, returned verbatim. Never throws on a closed store. */
  listSessions() {
    if (!this.enabled) return [];
    return all(this.db,
      'SELECT s.session_row, s.student_id, st.name AS student_name, s.source, s.started_at_wall_ms,'
      + ' s.ended_at_wall_ms, s.valid_ms, s.device, s.app_version, s.notes'
      + ' FROM observation_sessions s LEFT JOIN students st ON st.student_id = s.student_id'
      + ' ORDER BY s.ended_at_wall_ms DESC, s.session_row DESC');
  }

  /** One session's per-feature statistics (mean/std/n), in insertion order. Empty on a closed store. */
  sessionFeatures(sessionRow) {
    if (!this.enabled) return [];
    return all(this.db,
      'SELECT feature, mean, std, n FROM feature_records WHERE session_row = ? ORDER BY feature_id',
      [sessionRow]);
  }

  exportBytes() { return this.db.export(); }

  close() {
    try { this.db.close(); } catch (e) { /* already closed */ }
    this.enabled = false;
  }
}