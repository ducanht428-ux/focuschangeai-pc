// Browser-side storage for the learned profiles. This is the only file in desktop/js that touches a
// browser API for persistence, and it is the web equivalent of HabitStore.kt: the phone keeps one JSON
// file per student in its private storage, this keeps a habit-profile key and a learned-face key per
// student in this browser. The face key holds landmark ratios, never an image.
//
// Nothing here is shared or uploaded. The phone's profiles can travel to Firestore when a service key
// is present; this leg writes no network record, so a profile learned at the booth desk exists only in
// the browser that learned it. That is stated in the page, not implied.

import { profileFromJson, profileToJson } from './habit.mjs';

const KEY_STUDENTS = 'focuschange.students';
const KEY_CURRENT = 'focuschange.current';
const PREFIX = 'focuschange.habit.';

// HabitStore.kt:48 - a store that has never been written to opens with one student, not an empty list,
// because every other part of the app assumes there is somebody to bind the run to.
const DEFAULT_STUDENTS = [{ id: 'hs1', name: 'Học sinh 1' }];

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    // localStorage can throw when the whole origin is out of space, and a private-mode window in
    // Firefox throws on write. Either way the run must keep measuring: an unlearned session is a
    // smaller loss than a dead monitor.
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function students() {
  const raw = readJson(KEY_STUDENTS, null);
  const list = Array.isArray(raw)
    ? raw.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string')
    : [];
  if (list.length === 0) {
    persistStudents(DEFAULT_STUDENTS);
    // Copies, not the module's own objects: importBundle renames a row in place, and the default roster is
    // shared by every read until a write lands.
    return DEFAULT_STUDENTS.map((s) => ({ id: s.id, name: s.name }));
  }
  return list;
}

function persistStudents(list) {
  writeJson(KEY_STUDENTS, list);
}

export function currentId() {
  const list = students();
  const cur = readJson(KEY_CURRENT, null);
  const hit = list.find((s) => s.id === cur);
  return hit ? hit.id : list[0].id;
}

export function setCurrent(id) {
  writeJson(KEY_CURRENT, id);
}

export function nameOf(id) {
  const hit = students().find((s) => s.id === id);
  return hit ? hit.name : id;
}

/**
 * HabitStore.addStudent, same rules: trim, cap at 24 characters, fall back to a numbered name.
 *
 * The cap is not decoration - this string is printed in the HUD column and in every history line, and a
 * pasted full name would push the whole block off the screen the same way it does on the phone.
 */
export function addStudent(name) {
  const list = students();
  const clean = String(name || '').trim().slice(0, 24) || `Học sinh ${list.length + 1}`;
  const st = { id: 'hs' + Date.now(), name: clean };
  list.push(st);
  persistStudents(list);
  return st;
}

/** HabitStore.load - a missing or unreadable file is an empty profile, never an error. */
export function loadProfile(id) {
  const o = readJson(PREFIX + id, null);
  const p = profileFromJson(o);
  if (p) return p;
  const fresh = profileFromJson({ id, name: nameOf(id) });
  return fresh;
}

/** HabitStore.save. Returns false when the browser refused the write, so the page can say so. */
export function saveProfile(p) {
  return writeJson(PREFIX + p.id, profileToJson(p));
}

/** HabitStore.clear - used by the page's "Xóa hồ sơ đã học" button, which asks first. */
export function clearProfile(id) {
  try {
    localStorage.removeItem(PREFIX + id);
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The learned faces, one key per student next to the profile key.
//
// These live here and not in identity.mjs because this file owns localStorage on this leg: identity.mjs
// stays pure math so its geometry can be tested without a browser. The vectors are landmark ratios, not
// photographs - nothing that resembles a picture of a child is kept, and nothing leaves this browser.
const PREFIX_FACE = 'focuschange.face.';

/**
 * One student's stored samples: a list of signatures, empty when the face was never learned.
 *
 * A half-written or differently-shaped list reads back empty rather than throwing, because a corrupt
 * bank that half-matches is the failure mode that would bind the wrong child's profile.
 */
export function faceVectors(id) {
  return sanitizeFaceList(readJson(PREFIX_FACE + id, null));
}

/**
 * The face shape rule, shared by the read above and by an imported bundle.
 *
 * A bundle comes from a file somebody else produced, so it gets exactly the same test as a key written by
 * this browser: a vector is a non-empty list of finite numbers, and anything else is dropped rather than
 * partially trusted.
 */
function sanitizeFaceList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && isFinite(x)),
  );
}

/** Every bank in one read, so the matcher is loaded once at startup instead of once per student. */
export function faceRoster() {
  const out = {};
  for (const s of students()) {
    const list = faceVectors(s.id);
    if (list.length) out[s.id] = list;
  }
  return out;
}

/** Returns false when the browser refused the write, so the page can say the face was not kept. */
export function saveFace(id, list) {
  return writeJson(PREFIX_FACE + id, list);
}

export function clearFace(id) {
  try {
    localStorage.removeItem(PREFIX_FACE + id);
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The roster as one file: export and import.
//
// This is the only route a learned profile has out of a browser, and it is a file the operator picks up
// and puts down on purpose - nothing here touches the network, so what the header of this file says about
// uploads still holds. The bundles carry landmark ratios and the numbers the habit learner already kept,
// never a picture and never a frame.
//
// Import merges and never destroys. The realistic mistake is pointing an old backup at a booth that has
// been recording since the backup was taken, and the cost of getting that wrong is a term of sessions.
// Nothing here removes a student, a history entry or a learned face bank: what the file has and this
// machine already has is counted and left alone, and what it could not take is returned so the page can
// say which children still have to be re-learned here.

const BUNDLE_KIND = 'focuschange.pc.roster';
const BUNDLE_VERSION = 1;

/** A student slot no operator named - the roster every install starts with. */
const DEFAULT_NAME = /^h[sọ]c sinh \d+$/i;

function hasFaceBank(id) {
  return faceVectors(id).length > 0;
}

function hasHistory(id) {
  const p = profileFromJson(readJson(PREFIX + id, null));
  return !!p && (p.sessions.length > 0 || p.hasCalibration());
}

/**
 * Everything this browser knows, in one plain object.
 *
 * The shape is versioned because the file outlives the build that wrote it: a bundle taken today has to be
 * readable - or refused with a reason - after the storage layout changes.
 */
export function exportBundle() {
  const list = [];
  for (const s of students()) {
    const p = profileFromJson(readJson(PREFIX + s.id, null));
    list.push({
      id: s.id,
      name: s.name,
      profile: p ? profileToJson(p) : null,
      faces: faceVectors(s.id),
    });
  }
  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    current: currentId(),
    students: list,
  };
}

/** One id that is not in use yet, for a file that names a child this browser does not have. */
function freeId(taken) {
  let base = Date.now();
  while (taken.has('hs' + base)) base += 1;
  return 'hs' + base;
}

/**
 * Write a bundle into this browser, keeping whatever is already here.
 *
 * Returns the counts and the reason codes; the page owns the sentences, because an operator has to read
 * them and this file does not know Vietnamese wording.
 *
 * `reason` is set only when nothing at all could be read: 'json', 'kind', 'version', 'empty'.
 * The counters are what the operator gets told: `added` rows this machine did not have, `renamed` empty
 * default rows that took a name, `rekeyed` file children that had to be sat on a new id because the id in
 * the file belongs to somebody else here, `faces` signature frames written, `facesKept` children whose
 * local bank was left alone, `sessions` new history entries, `sessionsKnown` entries already recorded.
 */
export function importBundle(obj) {
  const r = {
    reason: '',
    added: 0,
    faces: 0,
    sessions: 0,
    facesKept: 0,
    sessionsKnown: 0,
    renamed: 0,
    rekeyed: 0,
  };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    r.reason = 'json';
    return r;
  }
  if (obj.kind !== BUNDLE_KIND) {
    r.reason = 'kind';
    return r;
  }
  if (typeof obj.version !== 'number' || obj.version > BUNDLE_VERSION) {
    r.reason = 'version';
    return r;
  }
  const incoming = (Array.isArray(obj.students) ? obj.students : []).filter(
    (s) => s && typeof s.id === 'string' && s.id && typeof s.name === 'string' && s.name.trim(),
  );
  if (!incoming.length) {
    r.reason = 'empty';
    return r;
  }

  const roster = students();
  const taken = new Set(roster.map((s) => s.id));

  for (const e of incoming) {
    const name = e.name.trim().slice(0, 24);
    const bank = sanitizeFaceList(e.faces);
    const fileProfile = e.profile && typeof e.profile === 'object' ? profileFromJson(e.profile) : null;
    const hit = roster.find((s) => s.id === e.id);
    const sameName = !!hit && hit.name.trim().toLowerCase() === name.toLowerCase();

    if (!hit) {
      const fresh = { id: e.id, name };
      roster.push(fresh);
      taken.add(fresh.id);
      r.added++;
      writeInto(fresh.id, name, bank, fileProfile, r);
      continue;
    }
    if (sameName) {
      writeInto(hit.id, hit.name, bank, fileProfile, r);
      continue;
    }
    // Different names on the same id. "Học sinh 1" is the row every install starts with, so two machines
    // can seat a different child on it and an id match there is not evidence of identity: it is adopted
    // only while it is still empty, and otherwise the file's child comes in under an id of its own.
    if (DEFAULT_NAME.test(hit.name.trim()) && !hasFaceBank(hit.id) && !hasHistory(hit.id)) {
      hit.name = name;
      r.renamed++;
      writeInto(hit.id, name, bank, fileProfile, r);
      continue;
    }
    const fresh = { id: freeId(taken), name };
    roster.push(fresh);
    taken.add(fresh.id);
    r.rekeyed++;
    writeInto(fresh.id, name, bank, fileProfile, r);
  }

  persistStudents(roster);
  return r;
}

/**
 * The two writes a bundle can ask for.
 *
 * Sessions merge, because two records of the same sitting carrying the same id is the only way a double
 * import stays harmless, and a number cannot bind the wrong child. Face banks do not merge: poses learned
 * by one camera onto a child this camera already learned would move the match radius, and the enrolment
 * rule above - a bank that half-matches is the failure mode - applies to a file the same way it applies to
 * a second press of the button. The local bank wins and the report says what was not taken.
 */
function writeInto(id, name, bank, fileProfile, r) {
  if (bank.length) {
    if (hasFaceBank(id)) r.facesKept++;
    else if (saveFace(id, bank)) r.faces += bank.length;
  }
  if (!fileProfile) return;
  const target = profileFromJson(readJson(PREFIX + id, null)) || profileFromJson({ id, name });
  target.id = id;
  if (!target.hasCalibration() && fileProfile.hasCalibration()) {
    // Distance scaling is a property of the camera and the desk, so it only arrives where nothing was
    // measured yet - an imported calibration must never quietly re-scale this booth's live numbers.
    target.distanceScale = fileProfile.distanceScale;
    target.calRawDistanceCm = fileProfile.calRawDistanceCm;
    target.calibratedAtMs = fileProfile.calibratedAtMs;
  }
  const known = new Set(target.sessions.map((s) => s.id));
  let added = 0;
  for (const s of fileProfile.sessions) {
    if (known.has(s.id)) {
      r.sessionsKnown++;
      continue;
    }
    if (target.commit(s)) added++;
  }
  // commit() appends and then trims from the front, which is right for a live run but wrong for a merge:
  // an old backup would push this machine's newest sessions out. The phone keeps them in time order, so
  // the cap always costs the oldest sitting.
  target.sessions.sort((a, b) => a.id - b.id);
  saveProfile(target);
  r.sessions += added;
}
