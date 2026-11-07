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
    return DEFAULT_STUDENTS.slice();
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
  const raw = readJson(PREFIX_FACE + id, null);
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
