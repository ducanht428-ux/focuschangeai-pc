// Layer 5 for the web leg - the same cloud sync the phone and the camera already have.
//
// The phone (FirebaseSync.kt) and the camera (firestore_writer.py) both write into one Firestore
// collection keyed by studentId, the phone under sessions/<id>-<n> and the camera under
// sessions/<id>-cam-<n>. This leg writes sessions/<id>-web-<n> beside them with the SAME column
// names, so one child recorded on a phone, a camera and this page is three rows a teacher reads by
// id - never one row that last-writer-wins. The namespacing lives in the key and nowhere else.
//
// The page holds no secret: it writes straight to Firestore over the public REST API, under the
// project's rules (narrowed to create/update on sessions/<…>-web-<n> carrying source "web-pc"). No
// SDK and no CDN script: the page must still boot with no network, so the cloud is a fetch that may
// fail, never a script that must load. When the write fails (offline, rules, quota) the payload is
// queued here and flushed on the next reach, the web twin of the edge-server's pending_upload.jsonl.
// A failed upload must never stop a recording or a Dừng.
import { HC, HF, HF_COUNT, HF_KEYS } from './habit.mjs';

export const SOURCE_TAG = 'web';
export const SOURCE = 'web-pc';
export const SCHEMA = 1;
// Public web config of the shared project - the one the Android app is registered in. Public by
// design; the rules, not secrecy, are what protect the store.
const FB_PROJECT = 'focuschangedai';
const FB_BASE = 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT
  + '/databases/(default)/documents';
const QUEUE_KEY = 'focuschange_pc_pending_upload';
const QUEUE_MAX = 50;

export function sanitize(studentId) {
  return String(studentId).replace(/[^A-Za-z0-9_-]/g, '-');
}

export function documentId(studentId, sessionId) {
  return sanitize(studentId) + '-' + SOURCE_TAG + '-' + sessionId;
}

// firestore_writer._round_to: floor(v*scale+0.5)/scale, not Math.round, so 0.125 goes up the way
// Kotlin and Python both send it. Two instruments measuring one child must not differ in the last digit.
function roundTo(v, scale) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0.0;
  return Math.floor(v * scale + 0.5) / scale;
}
const round2 = (v) => roundTo(v, 100);
const round4 = (v) => roundTo(v, 10000);

/**
 * The web twin of firestore_writer.build_session_payload: same keys, same conditions, same rounding.
 * A feature nobody measured stays absent rather than being stored as a zero.
 */
export function buildSessionPayload(o) {
  const s = o.summary;
  const out = {
    schema: SCHEMA,
    student_id: o.studentId,
    student_name: o.studentName,
    session_id: s.id,
    ended_at_wall_ms: o.endedAtWallMs,
    valid_ms: s.validMs,
    face_ratio: round4(s.faceRatio),
    valid_ratio: round4(s.validRatio),
    alerts_total: o.alertsTotal || 0,
    // The camera sends summary.count[SEI] as csv_rows; the web leg has no csv but the same meaning.
    csv_rows: o.csvRows != null ? o.csvRows : (s.count[HF.SEI] || 0),
    avg_fps: round2(o.avgFps || 0),
    device: o.device || SOURCE,
    app_version: o.appVersion || 'web',
    source: SOURCE,
    eligible: o.ineligibleReason == null,
    false_alerts: o.falseAlerts || 0,
  };
  if (s.qualityCount > 0) out.quality_mean = round2(s.quality);
  if (o.ineligibleReason != null) out.ineligible_reason = o.ineligibleReason;
  if (s.sensitivityLevel >= 0) out.sensitivity = s.sensitivityLevel;
  for (let f = 0; f < HF_COUNT; f++) {
    const n = s.count[f];
    if (n > 0) {
      const k = HF_KEYS[f];
      out['mean_' + k] = round2(s.mean[f]);
      out['std_' + k] = round2(s.std[f]);
      out['n_' + k] = n;
    }
  }
  const bands = o.bandOutcomes;
  if (bands && bands.length) {
    out.band_k = parseFloat(HC.BAND_K);
    for (const b of bands) {
      const k = HF_KEYS[b.feature];
      out['band_min_' + k] = round2(b.min);
      out['band_max_' + k] = round2(b.max);
      out['band_typical_' + k] = round2(b.mean);
      out['band_frames_' + k] = b.samples;
      out['band_below_' + k] = b.below;
      out['band_above_' + k] = b.above;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeQueue(list) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function pendingCount() {
  return readQueue().length;
}

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v) };
}

function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  return null;
}

// PATCH is create-or-replace, so a session re-sent from the queue lands on its own doc again instead
// of duplicating the run.
async function post(rec) {
  const fields = {};
  for (const k of Object.keys(rec.payload)) fields[k] = toValue(rec.payload[k]);
  const res = await fetch(FB_BASE + '/sessions/' + encodeURIComponent(rec.doc), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return isJson(res);
}

function isJson(res) {
  if (!res.ok) return false;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json');
}

/** Queue one finished session and try to drain. Never throws, never blocks the caller. */
export function queueSession(record) {
  const rec = { doc: record.doc, payload: record.payload };
  const list = readQueue().filter((p) => p.doc !== rec.doc);
  list.push(rec);
  while (list.length > QUEUE_MAX) list.shift();
  writeQueue(list);
  flush().catch(() => {});
  return list.length;
}

/** Send everything waiting; drops what the server accepted, keeps the rest for next time. */
export async function flush() {
  const list = readQueue();
  if (!list.length) return { sent: 0, left: 0 };
  const kept = [];
  let sent = 0;
  for (const rec of list) {
    try {
      if (await post(rec)) sent += 1;
      else kept.push(rec);
    } catch {
      kept.push(rec);
    }
  }
  writeQueue(kept);
  return { sent, left: kept.length };
}

/** Read one child's rows back from the shared store; [] when the store is unreachable. */
export async function fetchSessions(studentId) {
  try {
    const res = await fetch(FB_BASE + '/sessions:runQuery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'sessions' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'student_id' },
              op: 'EQUAL',
              value: { stringValue: String(studentId) },
            },
          },
          orderBy: [{ field: { fieldPath: 'ended_at_wall_ms' }, direction: 'DESCENDING' }],
        },
      }),
    });
    if (!isJson(res)) return [];
    const body = await res.json();
    if (!Array.isArray(body)) return [];
    return body.filter((r) => r && r.document).map((r) => {
      const out = {};
      const fields = r.document.fields || {};
      for (const k of Object.keys(fields)) out[k] = fromValue(fields[k]);
      return out;
    });
  } catch {
    return [];
  }
}

// Leftovers from an offline day drain as soon as the machine is back, not only at the next Dừng.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { flush().catch(() => {}); });
  flush().catch(() => {});
}
