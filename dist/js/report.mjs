// Human-readable session report, web/app leg. It reads the rows SqlStore already wrote and lays them
// out as a document a teacher can read or print - no new measurement, no invented number. Every figure
// is copied from observation_sessions / feature_records; a feature the run never measured is simply
// absent, never shown as a zero. The remarks are rule-based and say so, the same honesty the HUD and
// the context engine carry. Pure module: no DOM, no browser API, so the Node suite can replay it.

import { HF_KEYS, HC } from './habit.mjs';

// Vietnamese label, unit, rounding and whether the stored value is a DEVIATION from the student's own
// baseline (session.mjs observeHabit puts yawDev/pitchDev/gazeHDev/gazeVDev, not absolute angles). Order
// follows HF_KEYS so the table reads the same way every time. perclos carries no unit on purpose: the
// stored scale is not asserted here, the label describes what it is instead of claiming a percent.
export const FEATURE_INFO = {
  blink_bpm:    { label: 'Nhịp chớp mắt',            unit: 'lần/phút', dec: 1, dev: false },
  avg_blink_ms: { label: 'Thời gian mỗi lần chớp',   unit: 'ms',       dec: 0, dev: false },
  distance_cm:  { label: 'Khoảng cách tới camera',   unit: 'cm',       dec: 1, dev: false },
  yaw_deg:      { label: 'Quay đầu ngang (yaw)',     unit: '°',        dec: 1, dev: true },
  pitch_deg:    { label: 'Cúi/ngẩng đầu (pitch)',    unit: '°',        dec: 1, dev: true },
  gaze_h:       { label: 'Hướng nhìn ngang',         unit: '',         dec: 3, dev: true },
  gaze_v:       { label: 'Hướng nhìn dọc',           unit: '',         dec: 3, dev: true },
  mar:          { label: 'Độ mở miệng (MAR)',        unit: '',         dec: 3, dev: false },
  bfr:          { label: 'Nhíu mày (BFR)',           unit: '',         dec: 3, dev: false },
  ear:          { label: 'Độ mở mắt (EAR)',          unit: '',         dec: 3, dev: false },
  perclos_p60:  { label: 'Tỉ lệ nhắm mắt (PERCLOS)', unit: '',         dec: 1, dev: false },
  sei:          { label: 'Điểm tập trung (SEI)',     unit: '/100',     dec: 1, dev: false },
};

const CAVEAT = 'Số liệu đo tự động bằng luật viết tay, chưa kiểm định trên khuôn mặt thật; chỉ dùng để '
  + 'tham khảo, không thay cho đánh giá của giáo viên.';

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const p2 = (n) => String(n).padStart(2, '0');

/** Local-calendar date + clock, the way historyText prints it, plus seconds for a report. */
export function fmtDateTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'không rõ';
  const d = new Date(ms);
  return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear()
    + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

/** "2 phút 5 giây" from a millisecond span; never negative. */
export function fmtDuration(ms) {
  const t = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(t / 60), s = t % 60;
  if (m <= 0) return s + ' giây';
  return m + ' phút' + (s ? ' ' + s + ' giây' : '');
}

function num(v, dec) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return v.toFixed(dec);
}
const pct = (v) => (typeof v === 'number' && Number.isFinite(v)) ? (v * 100).toFixed(1) + '%' : '—';

function parseMeta(notes) {
  if (notes && typeof notes === 'object') return notes;
  try { const o = JSON.parse(notes || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}

/**
 * Turn one stored session + its feature rows into a plain report model. `session` is a listSessions()
 * row; `features` is sessionFeatures(row). Nothing here measures or guesses: an absent SEI is null, an
 * absent meta key is undefined, and the remarks only restate what the row already says.
 */
export function buildReportModel(session, features, opts = {}) {
  const meta = parseMeta(session.notes);
  const fmap = new Map();
  for (const f of features || []) fmap.set(f.feature, f);

  const seiRow = fmap.get('sei');
  const sei = (seiRow && seiRow.n > 0) ? { mean: seiRow.mean, std: seiRow.std, n: seiRow.n } : null;

  const rows = [];
  for (const key of HF_KEYS) {
    if (key === 'sei') continue; // the headline already carries SEI
    const f = fmap.get(key);
    if (!f || !(f.n > 0)) continue;
    const info = FEATURE_INFO[key] || { label: key, unit: '', dec: 2, dev: false };
    rows.push({ key, label: info.label, unit: info.unit, dev: info.dev,
      mean: num(f.mean, info.dec), std: num(f.std, info.dec), n: f.n });
  }

  const bands = [];
  for (const key of HF_KEYS) {
    const b = meta['band_' + key];
    if (!b || typeof b !== 'object' || !(b.frames > 0)) continue;
    const info = FEATURE_INFO[key] || { label: key };
    const below = b.below || 0, above = b.above || 0;
    bands.push({ key, label: info.label, below, above,
      within: Math.max(0, b.frames - below - above), frames: b.frames });
  }

  const startedMs = session.started_at_wall_ms;
  const endedMs = session.ended_at_wall_ms;
  const validMs = session.valid_ms || 0;
  const totalMs = (typeof startedMs === 'number' && typeof endedMs === 'number')
    ? Math.max(0, endedMs - startedMs) : null;
  const eligible = meta.eligible !== false; // older rows without the key read as eligible
  const reason = meta.ineligible_reason || null;

  const remarks = [];
  if (!eligible) {
    remarks.push('Phiên này CHƯA đạt chuẩn để đánh giá'
      + (reason ? ': ' + reason : '') + '. Các số liệu dưới đây chỉ mang tính tham khảo.');
  } else {
    remarks.push('Phiên đạt chuẩn tối thiểu (đủ thời lượng hợp lệ và tỉ lệ khung có mặt / khung hợp lệ).');
  }
  if (sei) {
    let s = 'Điểm tập trung SEI trung bình ' + num(sei.mean, 1) + '/100, tính trên ' + sei.n
      + ' khung hợp lệ (độ lệch chuẩn ' + num(sei.std, 1) + '). Thang 0–100, càng cao càng tập trung.';
    s += sei.mean < HC.MIN_SESSION_SEI
      ? ' Dưới ngưỡng tối thiểu của một phiên (' + HC.MIN_SESSION_SEI + ' điểm).'
      : ' Trên ngưỡng tối thiểu của một phiên (' + HC.MIN_SESSION_SEI + ' điểm).';
    remarks.push(s);
  } else {
    remarks.push('Không đo được điểm SEI trong phiên này (không có khung hợp lệ nào mang điểm tập trung).');
  }
  const cover = 'Tỉ lệ khung có mặt ' + pct(meta.face_ratio) + ', khung hợp lệ ' + pct(meta.valid_ratio) + '.';
  remarks.push(typeof meta.quality_mean === 'number'
    ? cover + ' Chất lượng tín hiệu trung bình ' + num(meta.quality_mean, 0) + '/100.'
    : cover);
  if (rows.some((r) => r.dev)) {
    remarks.push('Các chỉ số yaw / pitch / hướng nhìn là ĐỘ LỆCH so với mốc cá nhân của em, không phải góc tuyệt đối.');
  }

  return {
    studentName: session.student_name || session.student_id || 'Không rõ',
    studentId: session.student_id || '',
    sessionRow: session.session_row,
    source: session.source || '',
    device: session.device || '',
    appVersion: session.app_version || opts.appVersion || '',
    startedMs, endedMs, validMs, totalMs,
    eligible, reason,
    identity: meta.identity || null,
    faceRatio: meta.face_ratio, validRatio: meta.valid_ratio,
    qualityMean: typeof meta.quality_mean === 'number' ? meta.quality_mean : null,
    sei, rows, bands, remarks, caveat: CAVEAT,
    generatedMs: typeof opts.now === 'number' ? opts.now : Date.now(),
    classLabel: opts.classLabel || '',
  };
}

const SOURCE_LABEL = { 'pc-app': 'App PC (cài đặt)', 'pc-web': 'Web (trình duyệt)', 'edge-camera': 'Camera lớp' };
const IDENTITY_LABEL = { face: 'camera tự nhận', manual: 'người dùng chọn', self: 'tự khai' };

function statCard(label, value, sub) {
  return '<div class="rp-stat"><b>' + escapeHtml(value) + '</b><span>' + escapeHtml(label) + '</span>'
    + (sub ? '<i>' + escapeHtml(sub) + '</i>' : '') + '</div>';
}

/** The document body, as semantic HTML the page styles. All dynamic text is escaped. */
export function reportHtml(m) {
  const h = [];
  h.push('<header class="rp-head">'
    + '<div class="rp-kicker">Phần mềm theo dõi trạng thái học sinh</div>'
    + '<h1 class="rp-title">Báo cáo phiên theo dõi tập trung</h1>'
    + '<div class="rp-student">' + escapeHtml(m.studentName) + '</div>'
    + (m.classLabel ? '<div class="rp-class">' + escapeHtml(m.classLabel) + '</div>' : '')
    + '</header>');

  h.push('<div class="rp-meta">'
    + '<div><span>Bắt đầu</span><b>' + escapeHtml(fmtDateTime(m.startedMs)) + '</b></div>'
    + '<div><span>Kết thúc</span><b>' + escapeHtml(fmtDateTime(m.endedMs)) + '</b></div>'
    + '<div><span>Thời gian hợp lệ</span><b>' + escapeHtml(fmtDuration(m.validMs)) + '</b></div>'
    + (m.totalMs != null ? '<div><span>Tổng thời lượng</span><b>' + escapeHtml(fmtDuration(m.totalMs)) + '</b></div>' : '')
    + '</div>');

  h.push('<div class="rp-pill ' + (m.eligible ? 'ok' : 'warn') + '">'
    + (m.eligible ? '✓ Đạt chuẩn tối thiểu' : '⚠ Chưa đạt chuẩn')
    + (!m.eligible && m.reason ? ' — ' + escapeHtml(m.reason) : '')
    + (m.identity ? ' · Gắn tên: ' + escapeHtml(IDENTITY_LABEL[m.identity] || m.identity) : '')
    + '</div>');

  if (m.sei) {
    h.push('<div class="rp-sei"><div class="rp-sei-num">' + escapeHtml(num(m.sei.mean, 1))
      + '<small>/100</small></div>'
      + '<div class="rp-sei-side"><b>Điểm tập trung trung bình (SEI)</b>'
      + '<span>' + m.sei.n + ' khung hợp lệ · độ lệch chuẩn ' + escapeHtml(num(m.sei.std, 1)) + '</span>'
      + '<span class="rp-sei-scale">Thang 0–100, càng cao càng tập trung</span></div></div>');
  } else {
    h.push('<div class="rp-sei empty"><div class="rp-sei-num">—</div>'
      + '<div class="rp-sei-side"><b>Không đo được SEI</b>'
      + '<span>Phiên này không có khung hợp lệ nào mang điểm tập trung.</span></div></div>');
  }

  h.push('<div class="rp-stats">'
    + statCard('Khung có mặt', pct(m.faceRatio))
    + statCard('Khung hợp lệ', pct(m.validRatio))
    + statCard('Chất lượng tín hiệu', m.qualityMean != null ? num(m.qualityMean, 0) + '/100' : '—')
    + '</div>');

  if (m.rows.length) {
    h.push('<h2 class="rp-section-h">Chỉ số đo được</h2>');
    h.push('<table class="rp-table"><thead><tr><th>Chỉ số</th><th>Trung bình</th>'
      + '<th>Độ lệch chuẩn</th><th>Số khung</th></tr></thead><tbody>');
    for (const r of m.rows) {
      h.push('<tr><td>' + escapeHtml(r.label)
        + (r.dev ? ' <em class="rp-dev">lệch so với mốc</em>' : '')
        + '</td><td>' + escapeHtml(r.mean) + (r.unit ? ' <u>' + escapeHtml(r.unit) + '</u>' : '')
        + '</td><td>±' + escapeHtml(r.std) + '</td><td>' + r.n + '</td></tr>');
    }
    h.push('</tbody></table>');
  }

  if (m.bands.length) {
    h.push('<h2 class="rp-section-h">So với mốc cá nhân (số khung)</h2>');
    h.push('<table class="rp-table"><thead><tr><th>Chỉ số</th><th>Dưới mốc</th>'
      + '<th>Trong mốc</th><th>Trên mốc</th></tr></thead><tbody>');
    for (const b of m.bands) {
      h.push('<tr><td>' + escapeHtml(b.label) + '</td><td>' + b.below + '</td><td>'
        + b.within + '</td><td>' + b.above + '</td></tr>');
    }
    h.push('</tbody></table>');
  }

  h.push('<h2 class="rp-section-h">Nhận xét</h2><ul class="rp-remarks">');
  for (const r of m.remarks) h.push('<li>' + escapeHtml(r) + '</li>');
  h.push('</ul>');

  h.push('<p class="rp-caveat">' + escapeHtml(m.caveat) + '</p>');

  h.push('<footer class="rp-foot">'
    + '<span>Nguồn: ' + escapeHtml(SOURCE_LABEL[m.source] || m.source || 'không rõ')
    + (m.device ? ' · ' + escapeHtml(m.device) : '') + '</span>'
    + (m.appVersion ? '<span>Bản ghi: ' + escapeHtml(m.appVersion) + '</span>' : '')
    + '<span>Phiên #' + escapeHtml(m.sessionRow) + ' · tạo báo cáo ' + escapeHtml(fmtDateTime(m.generatedMs)) + '</span>'
    + '</footer>');

  return h.join('\n');
}

/** Plain-text twin, for the Node suite and a future copy action. Same numbers, no markup. */
export function reportText(m) {
  const L = [];
  L.push('BÁO CÁO PHIÊN THEO DÕI TẬP TRUNG');
  L.push('Học sinh: ' + m.studentName);
  L.push('Bắt đầu: ' + fmtDateTime(m.startedMs) + ' | Kết thúc: ' + fmtDateTime(m.endedMs));
  L.push('Thời gian hợp lệ: ' + fmtDuration(m.validMs)
    + (m.totalMs != null ? ' | Tổng: ' + fmtDuration(m.totalMs) : ''));
  L.push(m.eligible ? 'Đạt chuẩn tối thiểu.' : 'CHƯA đạt chuẩn' + (m.reason ? ': ' + m.reason : '') + '.');
  L.push(m.sei ? ('SEI trung bình: ' + num(m.sei.mean, 1) + '/100 (' + m.sei.n + ' khung, std ' + num(m.sei.std, 1) + ').')
    : 'SEI: không đo được.');
  L.push('Khung có mặt: ' + pct(m.faceRatio) + ' | Khung hợp lệ: ' + pct(m.validRatio)
    + (m.qualityMean != null ? ' | Chất lượng: ' + num(m.qualityMean, 0) + '/100' : ''));
  for (const r of m.rows) {
    L.push('- ' + r.label + (r.dev ? ' (lệch so với mốc)' : '') + ': ' + r.mean
      + (r.unit ? ' ' + r.unit : '') + ' ±' + r.std + ' (n=' + r.n + ')');
  }
  L.push('Nhận xét:');
  for (const r of m.remarks) L.push('  * ' + r);
  L.push(m.caveat);
  return L.join('\n');
}