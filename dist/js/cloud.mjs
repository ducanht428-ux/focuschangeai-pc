import { HC, HF, HF_COUNT, HF_KEYS } from './habit.mjs';

export const SOURCE_TAG = 'web';
export const SOURCE = 'web-pc';
export const SCHEMA = 1;
// Public Firebase web configuration; access is enforced by Auth and Firestore member rules.
const FB_KEY = 'AIzaSyAFiXJySBY5zvF-vGE23aqpjaEJNvT4NCw';
const FB_PROJECT = 'focuschangedai';
const FB_BASE = 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT
  + '/databases/(default)/documents';
const QUEUE_KEY = 'focuschange_pc_pending_upload';
const QUEUE_MAX = 50;
const listeners = new Set();
const requests = new Set();
let auth = null;
let authVersion = 0;
let signingIn = false;
let access = 'unchecked';
let lastError = '';
let flushJob = null;
let refreshJob = null;

export function cloudState() {
  return {
    user: auth ? { uid: auth.uid, email: auth.email } : null,
    signingIn, access, error: lastError, syncing: !!flushJob, pending: pendingCount(),
  };
}

function notify() {
  const state = cloudState();
  for (const listener of listeners) listener(state);
}

export function subscribeCloud(listener) {
  listeners.add(listener);
  listener(cloudState());
  return () => listeners.delete(listener);
}

function authMessage(code) {
  if (['INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD', 'EMAIL_NOT_FOUND', 'INVALID_EMAIL'].includes(code)) {
    return 'Email hoặc mật khẩu ứng dụng chưa đúng.';
  }
  if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') return 'Firebase tạm giới hạn đăng nhập. Hãy thử lại sau.';
  if (code === 'USER_DISABLED') return 'Tài khoản ứng dụng đã bị vô hiệu hóa.';
  if (code === 'OPERATION_NOT_ALLOWED') return 'Email/Mật khẩu chưa được bật trong Firebase Authentication.';
  return 'Không thể xác thực với Firebase. Kiểm tra cấu hình hoặc đăng nhập lại.';
}

async function requestJson(url, options, version) {
  const controller = new AbortController();
  requests.add(controller);
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const body = await res.json();
    if (version !== authVersion) throw new Error('Phiên đăng nhập đã thay đổi.');
    if (!res.ok) {
      const error = new Error(url.startsWith(FB_BASE)
        ? (res.status === 403
          ? 'Firebase từ chối quyền truy cập. Kiểm tra tài khoản có trong members và luật Firestore.'
          : res.status === 401 ? 'Phiên đăng nhập hết hiệu lực. Hãy đăng nhập lại.'
            : 'Firebase chưa nhận được yêu cầu. Hãy thử đồng bộ lại.')
        : authMessage(body.error?.message));
      error.status = res.status;
      error.code = body.error?.message;
      throw error;
    }
    return body;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError' || error instanceof SyntaxError) {
      throw new Error('Không kết nối được Firebase. Dữ liệu đã lưu trên máy vẫn được giữ.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    requests.delete(controller);
  }
}

export function signOut() {
  authVersion++;
  for (const controller of requests) controller.abort();
  auth = null;
  refreshJob = null;
  signingIn = false;
  access = 'unchecked';
  lastError = '';
  notify();
}

export async function signIn(email, password) {
  if (signingIn || auth) return;
  const version = ++authVersion;
  signingIn = true;
  lastError = '';
  notify();
  try {
    const data = await requestJson('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FB_KEY, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
    }, version);
    // Tokens stay in memory only; reopening the app requires a new sign-in.
    auth = {
      uid: data.localId, email: data.email, token: data.idToken, refresh: data.refreshToken,
      expires: Date.now() + Number(data.expiresIn) * 1000,
    };
    await verifyAccess(version);
  } catch (error) {
    if (version === authVersion) lastError = error.message;
  } finally {
    if (version === authVersion) { signingIn = false; notify(); }
  }
  if (version === authVersion && access === 'allowed') void flush();
}

async function idToken(version) {
  if (!auth || version !== authVersion) throw new Error('Hãy đăng nhập trong app để đồng bộ.');
  if (auth.expires > Date.now() + 60000) return auth.token;
  if (!refreshJob) {
    const session = auth;
    const job = requestJson('https://securetoken.googleapis.com/v1/token?key=' + FB_KEY, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refresh }).toString(),
    }, version).then((data) => {
      if (version !== authVersion || data.user_id !== session.uid) throw new Error('Phiên đăng nhập đã thay đổi.');
      auth = { ...session, token: data.id_token, refresh: data.refresh_token,
        expires: Date.now() + Number(data.expires_in) * 1000 };
      return auth.token;
    }).catch((error) => {
      if (version === authVersion && [400, 401, 403].includes(error.status)) {
        signOut();
        lastError = 'Phiên đăng nhập hết hiệu lực. Hãy đăng nhập lại; dữ liệu chờ vẫn ở máy.';
        notify();
      }
      throw error;
    }).finally(() => { if (refreshJob === job) refreshJob = null; });
    refreshJob = job;
  }
  return refreshJob;
}

async function firestore(path, options, version) {
  const token = await idToken(version);
  if (version !== authVersion) throw new Error('Phiên đăng nhập đã thay đổi.');
  try {
    return await requestJson(FB_BASE + path, {
      ...options, headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    }, version);
  } catch (error) {
    if (version === authVersion) {
      if (error.status === 403) access = 'denied';
      if (error.status === 401) signOut();
      lastError = error.message;
      notify();
    }
    throw error;
  }
}

async function verifyAccess(version) {
  await firestore(':runQuery', {
    method: 'POST', body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'sessions' }], select: { fields: [{ fieldPath: '__name__' }] }, limit: 1,
    } }),
  }, version);
  if (version === authVersion) { access = 'allowed'; lastError = ''; notify(); }
}

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

async function post(rec, version) {
  const fields = {};
  for (const k of Object.keys(rec.payload)) fields[k] = toValue(rec.payload[k]);
  return firestore('/sessions/' + encodeURIComponent(rec.doc), {
    method: 'PATCH', body: JSON.stringify({ fields }),
  }, version);
}

export async function queueSession(record) {
  const rec = { doc: record.doc, payload: record.payload, uid: auth?.uid || null, revision: crypto.randomUUID() };
  try {
    await navigator.locks.request(QUEUE_KEY, () => {
      const list = readQueue().filter((p) => p.doc !== rec.doc || (p.uid || null) !== rec.uid);
      if (list.length >= QUEUE_MAX) throw new Error('Hàng đợi đã đủ 50 phiên. Hãy đồng bộ và xuất hồ sơ để sao lưu phiên mới.');
      list.push(rec);
      if (!writeQueue(list)) throw new Error('Không lưu được hàng đợi trên máy. Hãy xuất hồ sơ để sao lưu.');
    });
    if (flushJob) void flushJob.then(() => flush());
    else void flush();
  } catch (error) {
    lastError = error.message;
  }
  notify();
  return pendingCount();
}

export function flush() {
  if (flushJob) return flushJob;
  if (!auth || access !== 'allowed') return Promise.resolve({ sent: 0, left: pendingCount() });
  const version = authVersion;
  const uid = auth.uid;
  // One uploader per origin prevents a second window from overwriting a newer server revision.
  flushJob = navigator.locks.request(QUEUE_KEY + '_sync', async () => {
    let sent = 0;
    if (version === authVersion) lastError = '';
    notify();
    while (version === authVersion && access === 'allowed') {
      try {
        const rec = await navigator.locks.request(QUEUE_KEY, () => {
          if (version !== authVersion) return null;
          const list = readQueue();
          const next = list.find((r) => !r.uid || r.uid === uid);
          // Unassigned offline records bind to the first member who syncs this device.
          if (next && !next.uid) {
            next.uid = uid;
            if (!writeQueue(list)) throw new Error('Không cập nhật được hàng đợi trên máy.');
          }
          return next;
        });
        if (!rec || version !== authVersion) break;
        const snapshot = JSON.stringify(rec);
        await post(rec, version);
        if (version !== authVersion) break;
        await navigator.locks.request(QUEUE_KEY, () => {
          // A recording may arrive during PATCH; only remove the acknowledged revision.
          const remaining = readQueue().filter((r) => JSON.stringify(r) !== snapshot);
          if (!writeQueue(remaining)) throw new Error('Đã gửi nhưng chưa cập nhật được hàng đợi trên máy.');
        });
        sent++;
        notify();
      } catch (error) {
        if (version === authVersion) lastError = error.message;
        break;
      }
    }
    return { sent, left: pendingCount() };
  }).finally(() => { flushJob = null; notify(); });
  notify();
  return flushJob;
}

export async function syncNow() {
  const version = authVersion;
  try {
    await verifyAccess(version);
    return await flush();
  } catch (error) {
    if (version === authVersion) { lastError = error.message; notify(); }
    return { sent: 0, left: pendingCount() };
  }
}

export async function fetchSessions(studentId) {
  const body = await firestore(':runQuery', {
    method: 'POST',
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'sessions' }],
      where: { fieldFilter: {
        field: { fieldPath: 'student_id' }, op: 'EQUAL', value: { stringValue: String(studentId) },
      } },
    } }),
  }, authVersion);
  return body.filter((r) => r && r.document).map((r) => {
    const out = {};
    const fields = r.document.fields || {};
    for (const k of Object.keys(fields)) out[k] = fromValue(fields[k]);
    return out;
  }).sort((a, b) => (b.ended_at_wall_ms || 0) - (a.ended_at_wall_ms || 0));
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (auth) void syncNow(); });
  window.addEventListener('storage', (event) => { if (event.key === QUEUE_KEY) notify(); });
}
