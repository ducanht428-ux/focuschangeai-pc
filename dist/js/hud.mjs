// The phone's HUD text, line for line, for the browser build.
//
// Ported from edge-server/focusedge/hud.py, which is itself a copy of MainActivity.analyzeFrame and
// applyHudText. It owns the ORDER of the column as well as the words: the page before this one had its
// own shorter labels ("Chop / phut", "Do mo mat") grouped by subject, so the same minute of one child's
// attention read as a different set of sentences on each screen - the one thing a demo that compares two
// instruments cannot afford.
//
// The field names below are HudState's from hud.py, camelCased, on purpose: toHud() is the seam where
// this leg's result object becomes that shape, and after it every sentence is built from the same
// identifier the Python window builds it from. Diffing the two files line by line is how a drift gets
// found, and it only works if the two sides name things the same.
//
// A row prints "--" when this leg genuinely does not measure that quantity. It never prints a number
// borrowed from a different calculation, and never invents a name, a profile or a CSV state it lacks.

import { SITUATION_VI } from './situation.mjs';
import { alertSentence } from './alerts.mjs';
import { HC } from './habit.mjs';

// Material3 on a light surface, as the phone's Compose theme renders them and as hud.py converts them.
// Kept as [r,g,b] so the same values reach both the DOM and the canvas.
export const C = {
  ON_SURFACE: [28, 27, 31],
  SURFACE: [255, 251, 254],
  GRAY: [136, 136, 136],
  RED: [255, 0, 0],
  SEI_GOOD: [46, 125, 50],
  SEI_FAIR: [249, 168, 37],
  SEI_MED: [239, 108, 0],
  PRIMARY: [102, 80, 164],
  ALERT_ORANGE: [239, 108, 0],
  HINT_AMBER: [255, 160, 0],
  HINT_BLUE: [79, 195, 247],
};

// Type.kt overrides only titleLarge (22 sp); the rest are Material3 defaults, mapped onto preview pixels
// at a size that stays readable in a 640-pixel-wide column.
const HEADLINE = 19;
const TITLE_L = 17;
const TITLE_M = 14;
const TITLE_S = 12;
const SMALL = 11;

// The pixel numbers above are this leg's geometry, not a fact about the phone. The fact that travels is
// which Compose text style each row came from, so hud.py's Line.style has a mirror here and the page can
// paint the phone's real type scale instead of a preview-sized approximation.
const SIZE_TO_STYLE = {
  [HEADLINE]: 'headlineSmall',
  [TITLE_L]: 'titleLarge',
  [TITLE_M]: 'titleMedium',
  [TITLE_S]: 'titleSmall',
  [SMALL]: 'bodySmall',
  13: 'bodyLarge',
};

// Type.kt overrides only titleLarge; the rest are Material3 defaults read off the phone at its own scale.
// Weight is included because Material3 fixes it per style - titleMedium and titleSmall are Medium, the
// others Regular - so no caller gets to decide what looks bold on this screen.
export const PHONE_TYPE = {
  headlineSmall: { px: 24, weight: 400, lh: 1.25 },
  titleLarge: { px: 22, weight: 400, lh: 1.25 },
  titleMedium: { px: 16, weight: 500, lh: 1.3 },
  titleSmall: { px: 14, weight: 500, lh: 1.3 },
  bodyLarge: { px: 16, weight: 400, lh: 1.5, ls: 0.5 },
  bodySmall: { px: 12, weight: 400, lh: 1.35 },
};

const MEDIUM_STYLES = new Set(['titleMedium', 'titleSmall']);

export function styleOf(size) {
  return SIZE_TO_STYLE[size || 13] || 'bodyLarge';
}

// A row whose text is this marker is not text at all: it is the slot the phone's SEI sparkline occupies,
// between the header and the chronic line (MainActivity.kt:1071-1109). The renderer draws it and this
// module owns where it sits, so the curve cannot drift to the bottom of the column on its own.
export const CHART_ROW = '\x00sei_chart';

// What gets painted over the camera. The phone's Canvas draws nothing but dots here
// (MainActivity.kt:2019-2052): iris landmarks cyan r=3, the two eye rings yellow r=4, everything else
// green r=2. Iris landmarks start at 468. Unlike the class camera this leg runs the landmark model on
// the whole frame, exactly as the phone does, so the 0..1 numbers need no re-basing through a crop box.
export const IRIS_FIRST = 468;
export const EYE_DRAW = new Set([33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380]);
export const DOT = {
  iris: { colour: [0, 255, 255], r: 3 },
  eye: { colour: [255, 255, 0], r: 4 },
  mesh: { colour: [0, 255, 0], r: 2 },
};

// This sentence was copied from MainActivity.kt:1382, where it is true because the phone uploads to
// Firestore and has a share button. Neither exists in this leg, so the text says what this build does.
export const PRIVACY_NOTE = 'Mọi phép đo chạy trên máy này; app không lưu ảnh, không lưu video. '
  + 'Hồ sơ và điểm đo chỉ nằm trong trình duyệt của máy này, app không gửi chúng đi đâu; '
  + 'muốn mang sang máy khác dùng "Xuất danh sách".';

/**
 * Format a number the way the phone does, or print its dash when there is none.
 *
 * The caller passes the format instead of trusting toFixed's defaults because "45.2 cm" and "0.083" are
 * what the other two screens print, and a column whose decimals drift reads like a different measurement.
 */
export function num(v, fmt = '%.1f') {
  if (v === null || v === undefined) return '--';
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  if (fmt === '%d') return String(Math.trunc(n));
  const digits = /^%\.(\d+)f$/.exec(fmt);
  return n.toFixed(digits ? Number(digits[1]) : 1);
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

export { rgb };

// ---------------------------------------------------------------------------
// The three lookup tables (MainActivity.kt:2060-2081, describeSituation :2837)
// ---------------------------------------------------------------------------
export function seiLabel(sei) {
  if (sei === null || sei === undefined || sei < 0) return '--';
  if (sei >= 80) return 'Tốt';
  if (sei >= 60) return 'Khá';
  if (sei >= 40) return 'Trung bình';
  return 'Thấp';
}

export function seiColour(sei) {
  if (sei === null || sei === undefined || sei < 0) return C.GRAY;
  if (sei >= 80) return C.SEI_GOOD;
  if (sei >= 60) return C.SEI_FAIR;
  if (sei >= 40) return C.SEI_MED;
  return C.RED;
}

export function fatigueLabel(index) {
  if (index < 25) return 'Tỉnh táo';
  if (index < 50) return 'Hơi mệt';
  if (index < 75) return 'Mệt';
  return 'Rất mệt';
}

// ---------------------------------------------------------------------------
// The seam: this leg's result -> HudState
// ---------------------------------------------------------------------------
/**
 * Turn one MonitorSession result into the field names hud.py reads.
 *
 * A frame with no face has no result at all and the caller passes null, which is what produces the
 * phone's "Khong phat hien khuon mat". A frame with a face but no finished calibration still has a
 * HudState on the phone, so it gets one here too - with the measured geometry (angles, quality, EAR)
 * filled in and every quantity that needs the baseline left absent, so each line falls to its own dash
 * instead of to a number the engine has not earned yet.
 */
export function toHud(r) {
  if (!r) return null;
  const on = !!r.calibrated;
  const e = r.eye || {};
  return {
    calibrated: on,
    calibrating: !on,
    calibProgress: r.calibration ? r.calibration.frames : 0,
    calibTotal: r.calibration ? r.calibration.target : 60,
    baselineEar: r.baselineEar === undefined ? null : r.baselineEar,
    landmarkCount: r.landmarkCount || 0,

    ear1: r.ear1,
    ear2: r.ear2,
    openness: on ? e.openness : NaN,
    sigma: on ? e.sigma : NaN,
    squintPct: on ? e.squintPct : NaN,
    asymPct: on ? e.asymPct : NaN,
    incompleteRatio: on ? e.incompleteRatio : NaN,
    eyeValid: on ? !!e.valid : false,
    usingBlendshapes: !!e.usingBlendshapes,
    noisy: !!e.noisy,
    squintAlert: !!e.squintAlert,
    asymAlert: !!e.asymAlert,
    incompleteAlert: !!e.incompleteAlert,
    closed: !!e.closed,
    drowsy: !!r.drowsyNow,
    blinkTotal: on ? r.blinkTotal : 0,
    avgBlinkMs: on ? r.avgBlinkMs : null,

    perclos: on ? r.perclos : null,
    perclosP70: on ? r.perclosP70 : null,
    perclosP80: on ? r.perclosP80 : null,
    bpm: on && r.bpmReliable ? r.bpm : null,

    distanceCm: on ? r.distanceCm : null,
    // HudState.distance_scale is a float that defaults to 1.0 and is never None, so the leg's own
    // not-yet-calibrated state arrives here as the same 1.0 the Python window prints.
    distanceScale: r.distanceScale === undefined || r.distanceScale === null ? 1.0 : r.distanceScale,
    tooClose: on ? !!r.tooClose : false,

    yaw: r.yawDeg,
    pitch: r.pitchDeg,
    roll: r.rollDeg,

    irisAvailable: !!r.irisAvailable,
    gazeHDev: on ? r.gazeHDev : null,
    gazeVDev: on ? r.gazeVDev : null,
    eyesOpenForGaze: !!r.eyesOpenForGaze,
    driftNow: !!r.driftNow,
    driftLong: !!r.driftLong,
    driftMs: on ? r.driftMs : 0,
    lookAwayLong: !!r.lookAwayLong,

    mar: on ? r.mar : NaN,
    bfr: on ? r.bfr : NaN,
    yawnConfirmed: !!r.yawnConfirmed,
    furrowNow: !!r.furrowNow,
    confusedSustained: !!r.confusedSustained,
    yawnsRecent: on ? r.yawnsRecent : 0,

    sei: on ? r.sei : null,
    averageSei: on ? r.averageSei : null,
    minSei: on ? r.minSei : null,
    fatigue: on ? r.fatigue : null,
    chronicLevel: on ? r.chronicLevel : 0,

    quality: r.quality === undefined ? null : r.quality,
    qualityNote: r.qualityNote === undefined ? null : r.qualityNote,
    reliable: r.reliable === undefined ? true : !!r.reliable,

    alertMessage: on ? r.alertCode : null,
    alertHeld: !!r.alertHeld,
    personalSeiMean: on ? r.personalSeiMean : null,
    intervened: on ? r.intervened : 0,
    suppressed: on ? r.suppressed : 0,
    sessionSeconds: on ? r.sessionSeconds : 0,
    situation: on ? r.situation : 5,

    // The learned layer. All four are absent from a Python recording - that leg has no habit profile -
    // and each default below is the value that keeps this column byte-identical to the recorded rows.
    studentName: r.studentName === undefined ? null : r.studentName,
    habit: r.habit === undefined ? null : r.habit,
    band: r.band === undefined ? null : r.band,
    history: r.history === undefined ? '' : r.history,
  };
}

// ---------------------------------------------------------------------------
// The individual status sentences
// ---------------------------------------------------------------------------

/** currentEyeStatus, MainActivity.kt:4361-4367, the same five branches in the same order. */
export function eyeStatus(h) {
  if (!h) return 'Không phát hiện khuôn mặt';
  if (h.drowsy) return 'Nhắm lâu - có thể buồn ngủ';
  if (h.closed) return 'Đang nhắm';
  if (!h.eyeValid) return 'Tạm bỏ qua (góc nghiêng lớn hoặc tín hiệu kém)';
  if (h.squintAlert) return 'Mắt khép hoặc nheo một phần kéo dài';
  return 'Đang mở hoặc chuyển trạng thái';
}

/** eyeDetail, MainActivity.kt:4316-4329. */
export function eyeDetail(h) {
  if (!h || !h.eyeValid) return 'Góc nghiêng lớn hoặc tín hiệu kém: tạm bỏ qua phân tích mắt';
  const source = h.usingBlendshapes ? 'AI blendshape + hình học' : 'hình học (chưa bật blendshape)';
  const glare = h.noisy ? ' | kính/chói gây nhiễu' : '';
  return `độ mở ${num(h.openness, '%.2f')} | nhiễu ${num(h.sigma, '%.2f')}`
    + ` | nheo ${num(h.squintPct, '%.0f')}% | lệch 2 mắt ${num(h.asymPct, '%.0f')}% | ${source}${glare}`;
}

/**
 * gazeStatus, MainActivity.kt:4415-4433.
 *
 * The two gates arrive as arguments: the drift flag was raised against this session's own thresholds,
 * which the slider moves, and describing it with the hardcoded constants would let the sentence explain
 * the number with a different rule than the number was made by.
 */
export function gazeStatus(h, thrH, thrV) {
  if (!h || !h.irisAvailable) return 'Không có dữ liệu mống mắt';
  if (!h.reliable) return 'Tín hiệu kém, tạm bỏ qua';
  if (!h.eyesOpenForGaze) return 'Mắt đang nhắm';
  const horizontal = Math.abs(h.gazeHDev) / thrH >= Math.abs(h.gazeVDev) / thrV;
  const direction = horizontal ? (h.gazeHDev > 0 ? 'trái' : 'phải') : (h.gazeVDev > 0 ? 'xuống' : 'lên');
  if (h.driftLong) return `Visual Drift: lệch sang ${direction} ${num(h.driftMs / 1000)} giây`;
  if (h.driftNow) return `Đang liếc sang ${direction}`;
  return 'Nhìn vào màn hình';
}

/** expressionStatus, MainActivity.kt:4491-4496. */
export function expressionStatus(h) {
  // The phone reaches its "Dang hieu chuan" branch when there is no frame data at all, not when the
  // baseline is still being learned, so a calibrating face really does read "Binh thuong" up there. That
  // is the other window's behaviour and this column's job is to reproduce it, not to improve on it.
  if (!h) return 'Đang hiệu chuẩn';
  if (h.yawnConfirmed) return 'Ngáp (dấu hiệu mệt mỏi)';
  if (h.confusedSustained) return 'Nhíu mày kéo dài (bối rối / căng thẳng)';
  if (h.furrowNow) return 'Hơi nhíu mày';
  return 'Bình thường';
}

/** situationStatus, MainActivity.kt:4775-4780: the tally is appended only once it is non-zero. */
export function situationStatus(h, situation) {
  const text = SITUATION_VI[situation] || '--';
  if (!h || h.intervened === 0) return text;
  return `${text} · đã hoãn ${h.intervened} lần, bỏ hẳn ${h.suppressed} lần`;
}

/** headPoseText, MainActivity.kt:5000-5010. All three angles or nothing. */
export function headPoseText(h) {
  if (!h) return '--';
  if (!Number.isFinite(h.yaw) || !Number.isFinite(h.pitch) || !Number.isFinite(h.roll)) return '--';
  return `Yaw ${signed(h.yaw)}° (+ = trái) | Pitch ${signed(h.pitch)}° (+ = cúi) | Roll ${signed(h.roll)}°`;
}

function signed(v) {
  return (v >= 0 ? '+' : '') + num(v);
}

/**
 * calibrationLabelFrom, MainActivity.kt:5175-5192.
 *
 * The phone's second number is its closing threshold in EAR units; this engine decides closure on a
 * normalised openness ratio, so there is no same-quantity value to print and the slot keeps the dash
 * rather than borrowing a number that means something else.
 */
export function calibrationText(h) {
  if (!h) return '--';
  if (!h.calibrating) return `Hoàn tất (EAR cơ sở ${num(h.baselineEar, '%.3f')}, ngưỡng nhắm --)`;
  const hint = (h.quality !== null && h.quality < 50) ? ` - ${h.qualityNote}` : '';
  return `Đang hiệu chuẩn ${h.calibProgress}/${h.calibTotal} - hãy nhìn thẳng, mở mắt tự nhiên${hint}`;
}

/**
 * The phone's habitStatus line (buildHabitStatus, MainActivity.kt:2940-2980).
 *
 * Three states, and each one says what is actually true of this machine:
 *   * nobody is bound to a profile - this leg's own sentence, identical to hud.py's empty-roster one;
 *   * fewer than MIN_SESSIONS usable sessions - a count of what is still missing;
 *   * a ready profile - how much of the judgement is now this student's own.
 * The last suffix is the phone's: the run in progress is reported in minutes of VALID time, not wall
 * clock, so an operator can see why a 10-minute sitting only learned 3 minutes of it.
 */
export function habitStatus(h) {
  const hb = h && h.habit;
  if (!hb) return 'Đang học thói quen: hồ sơ chưa gắn tên nên chưa có phiên nào được lưu.';
  const suffix = hb.hasSession
    ? ` Phiên này: ${num(hb.currentValidMs / 60000, '%.1f')} phút hợp lệ`
    : ' Phiên mới sẽ bắt đầu sau khi hiệu chuẩn xong.';
  if (hb.ready) {
    const total = 8;
    return `Hồ sơ cá nhân: ${hb.sessions} phiên, ${num(hb.totalMin, '%.0f')} phút - `
      + `${hb.personalCount}/${total} ngưỡng riêng, ${total - hb.personalCount} mặc định `
      + `(tin cậy ${num(hb.confidence * 100, '%.0f')}%).` + suffix;
  }
  return `Đang học thói quen: ${hb.sessions}/${HC.MIN_SESSIONS} phiên đạt, `
    + `${num(hb.totalMin, '%.0f')}/${HC.MIN_TOTAL_MS / 60000} phút hợp lệ.` + suffix;
}

/**
 * The phone's habitDetail block (MainActivity.kt:2506-2537): the learned base, the thresholds it moved,
 * and the honest split between learned and default. Empty when there is no ready profile, exactly as on
 * the phone, where the block is only built inside applyPersonalParams.
 */
export function habitDetail(h, thr) {
  const hb = h && h.habit;
  if (!hb || !hb.ready || hb.blend <= 0) return '';
  const parts = [];
  if (hb.meanBpm !== null && hb.meanBpm !== undefined) {
    parts.push(`chớp ${num(hb.meanBpm, '%.0f')} lần/phút`);
  }
  if (hb.meanDist !== null && hb.meanDist !== undefined) {
    parts.push(`ngồi cách ${num(hb.meanDist, '%.0f')} cm`);
  }
  const head = parts.length ? `Mức cơ sở cá nhân: ${parts.join('; ')}; ` : 'Mức cơ sở cá nhân: ';
  let s = head + `cảnh báo quay đầu > ${num(thr.lookYaw, '%.0f')}°/${num(thr.lookPitch, '%.0f')}°; `
    + `liếc mắt > ${num(thr.gazeH, '%.2f')}/${num(thr.gazeV, '%.2f')}; `
    + `PERCLOS cảnh báo > ${num(thr.perclos, '%.0f')}%`;
  if (hb.meanSei !== null && hb.meanSei !== undefined) {
    s += `; SEI quen thuộc ${num(hb.meanSei, '%.0f')}`;
  }
  const total = 8;
  s += `. ${hb.personalCount}/${total} ngưỡng có trộn cá nhân, cá nhân chỉ chiếm `
    + `${num(hb.blend * 100, '%.0f')}% nên ${num((1 - hb.blend) * 100, '%.0f')}% vẫn là mặc định; `
    + `${total - hb.personalCount} ngưỡng chưa có dữ liệu để trộn.`;
  return s;
}

/**
 * The phone's one-line band summary (refreshBandText, MainActivity.kt:2860-2901).
 *
 * Descriptive only: it says what this student looks like when they are being themselves and changes no
 * threshold. "No band yet" is printed as its own sentence, because reporting 0 % out-of-band for a
 * profile that never built a band would read as "always normal".
 */
export function bandSummary(band, hb) {
  if (!band) return 'Dải hai phía: chưa có phiên nào đang đo (chỉ có sau khi hiệu chuẩn xong).';
  if (band.noBands) {
    return `Dải hai phía: chưa dựng được chỉ số nào (cần ${HC.MIN_SESSIONS} phiên đạt, `
      + `hồ sơ có ${hb ? hb.sessions : 0}).`;
  }
  const inside = band.samples - band.below - band.above;
  return `Dải hai phía (${band.covered}/${band.total} chỉ số): `
    + `${num((inside * 100) / band.samples, '%.1f')}% lượt đo nằm trong dải, `
    + `${num((band.below * 100) / band.samples, '%.1f')}% dưới, `
    + `${num((band.above * 100) / band.samples, '%.1f')}% trên - tính trên ${band.samples} lượt đo, `
    + `mỗi khung chấm tối đa ${band.total} chỉ số. Mô tả, không phải cảnh báo.`;
}

// ---------------------------------------------------------------------------
// The whole column
// ---------------------------------------------------------------------------
function line(text, size, colour, bold) {
  const s = size || 13;
  return { text, size: s, style: styleOf(s), colour: colour || C.ON_SURFACE, bold: !!bold };
}

/**
 * Every text line the phone shows between its title and its camera preview.
 *
 * @param {object|null} h HudState-shaped data from toHud(), or null when this frame holds nobody.
 * @param {number} faceCount how many faces the frame holds. The phone asks for one, and this leg asks
 *   for one until the operator sets "Số mặt" above it - then it reports every head the model found,
 *   while the numbers below still belong to the single head being measured.
 * @param {number} processingMs the same millisecond figure the phone's recognition line prints.
 * @param {number} fps frames per second.
 * @param {{gazeH:number, gazeV:number}} thr the session's own drift gates.
 * @param {string|null} imgProc the frame's image-enhancement state, as enhance.mjs describes it. The
 *   page passes it; the parity checker does not, so the recorded Python fixture keeps its dash.
 */
export function hudLines(h, faceCount, processingMs, fps, thr, imgProc) {
  const calibrated = !!h && h.calibrated;
  const out = [];
  const add = (l) => out.push(l);

  add(line('FocusChangeAI', HEADLINE, C.ON_SURFACE, true));
  add(line(faceCount > 0 ? 'Đã phát hiện khuôn mặt.' : 'Chưa phát hiện khuôn mặt.'));

  const sei = h ? h.sei : null;
  if (sei === null || sei === undefined) {
    add(line('SEI 2.0: -- / 100', TITLE_L, C.GRAY, true));
  } else {
    add(line(`SEI 2.0: ${Math.round(sei)} / 100 (${seiLabel(sei)})`, TITLE_L, seiColour(sei), true));
  }
  add(line(CHART_ROW));

  // ---- lines the phone shows above the parameter column, in its order ----
  if (h && h.chronicLevel === 2) {
    add(line('⛔ CẢNH BÁO MẤT TẬP TRUNG KÉO DÀI - hãy nghỉ ngơi hoặc tập trung lại.', TITLE_S, C.RED));
  } else if (h && h.chronicLevel === 1) {
    add(line('⚠ Cần chú ý: các lần mất tập trung đang tăng lên.', TITLE_S, C.SEI_MED));
  }

  if (h && h.tooClose) {
    add(line('⚠ Cảnh báo: bạn đang ngồi quá gần màn hình (< 30 cm)!', TITLE_S, C.RED));
  }

  // Computed once: the phone reads the same situation string for its situation line below and for the
  // prefix of a held alert (MainActivity.kt:5074), and two calls could disagree.
  const sitText = situationStatus(h, h ? h.situation : 5);

  let sentence = h ? alertSentence(h.alertMessage, h.personalSeiMean, h.qualityNote) : '';
  if (sentence && h && h.alertHeld) {
    // A held alert says what is holding it instead of showing nothing: an operator who sees a closed eye
    // and no line cannot tell "delayed by the context layer" from "broken".
    sentence = `${sitText} - đang hoãn cảnh báo: ${sentence}`;
  }
  if (sentence) add(line(sentence, TITLE_S, C.ALERT_ORANGE));

  add(line(''));
  add(line(`Học sinh: ${h && h.studentName ? h.studentName : 'chưa gắn tên'}`, TITLE_M));
  if (!calibrated) {
    add(line('Đang nạp hồ sơ học sinh...', SMALL));
  } else {
    add(line(habitStatus(h), SMALL));
  }
  // The three learned blocks are printed only once a student is bound. hud.py has no habit layer at all,
  // so a machine with no profile must keep printing exactly the two recorded lines - and a bound student
  // gets the phone's order (MainActivity.kt:1156-1174): status, detail, band, history.
  if (h && h.habit) {
    const detail = habitDetail(h, thr || {});
    if (detail) add(line(detail, SMALL));
    add(line(bandSummary(h.band, h.habit), SMALL));
    if (h.history) add(line(`Các phiên gần đây:\n${h.history}`, SMALL));
  }
  // Written as two whole sentences rather than one interpolated tail: wording-check pins the unbound row
  // letter for letter against hud.py:382, and an interpolation hides it from a grep of this file.
  add(line(h && h.studentName ? `Máy này đang gắn với: ${h.studentName}`
    : 'Máy này đang gắn với: chưa gắn tên', SMALL));

  add(line(`Số khuôn mặt: ${faceCount}`, TITLE_M));
  add(line(`Số điểm mốc: ${h ? h.landmarkCount : 0}`));
  add(line(`Số lần chớp mắt: ${h ? h.blinkTotal : 0}`, TITLE_M, C.PRIMARY));
  add(line(`Nhịp chớp mắt (BPM): ${num(h ? h.bpm : null)}`));

  add(line(`EAR mắt 1: ${num(h ? h.ear1 : null, '%.3f')}`));
  add(line(`EAR mắt 2: ${num(h ? h.ear2 : null, '%.3f')}`));
  add(line(`Trạng thái mắt: ${eyeStatus(h)}`));
  add(line(h ? `Phân tích mắt: ${eyeDetail(h)}` : 'Phân tích mắt: --'));
  // The phone's image-processing line describes its brightness-enhancer stage (MainActivity.kt:1336,
  // fed by enhancer.describe() at 5426, and "--" before the first frame at 781). This leg now has the
  // same stage, so it prints the same sentence. The Python window keeps its dash: that leg hands raw
  // frames to the landmark model with no enhancer at all (hud.py:396-398).
  add(line(`Xử lý ảnh: ${imgProc || '--'}`));

  const distColour = h && h.tooClose ? C.RED : C.ON_SURFACE;
  // The scale is printed whenever there is a face, even at its untouched 1.00 before the ruler has
  // calibrated itself: the other window shows "he so x1.00" in that state, and hiding the number until it
  // is interesting would make the two screens disagree about a factor the operator can see.
  const scale = h ? `x${num(h.distanceScale, '%.2f')}` : '--';
  add(line(`Khoảng cách: ${num(h ? h.distanceCm : null)} (hệ số ${scale} của hồ sơ này)`, 13, distColour));

  add(line(`Tư thế đầu: ${headPoseText(h)}`));
  add(line(`Hướng nhìn: ${gazeStatus(h, thr ? thr.gazeH : 0.16, thr ? thr.gazeV : 0.22)}`));
  add(line(`Tình huống: ${sitText}`));
  add(line(`Vi biểu cảm: ${expressionStatus(h)}`));
  if (h && Number.isFinite(h.mar) && Number.isFinite(h.bfr)) {
    add(line(`Chỉ số: BFR ${num(h.bfr, '%.2f')} | MAR ${num(h.mar, '%.2f')} | Ngáp (5 phút): ${h.yawnsRecent}`));
  } else {
    add(line('Chỉ số: --'));
  }
  // No inattention accumulator or violation score exists on this leg, and a dash is the phone's own
  // answer for that: inattentionText stays "--" while its window is too short.
  add(line('Mất tập trung: --'));

  add(line(`Mệt mỏi (tỉ lệ nhắm mắt): ${num(h ? h.perclos : null)}`));
  add(line(`PERCLOS P70/P80: ${num(h ? h.perclosP70 : null)} / ${num(h ? h.perclosP80 : null)}`));
  // The phone prints its CSV logger state here. This leg writes no per-frame CSV, so the line keeps its
  // place in the column with the phone's "not measured" dash.
  add(line('Ghi CSV: --', SMALL));

  if (!h || h.fatigue === null || h.fatigue === undefined) {
    add(line('Chỉ số mệt mỏi: --'));
  } else {
    const blinkPart = h.avgBlinkMs === null || h.avgBlinkMs === undefined
      ? '' : ` | Chớp TB ${num(h.avgBlinkMs, '%.0f')} ms`;
    add(line(`Chỉ số mệt mỏi: ${Math.round(h.fatigue)} / 100 (${fatigueLabel(h.fatigue)})${blinkPart}`));
  }

  if (!h || h.quality === null) {
    add(line('Chất lượng tín hiệu: --'));
  } else {
    add(line(`Chất lượng tín hiệu: ${Math.round(h.quality)} / 100 (${h.qualityNote})`));
  }

  add(line(`Hiệu chuẩn: ${calibrationText(h)}`));

  if (h && calibrated) {
    const s = h.sessionSeconds;
    add(line(`Phiên làm việc: ${pad(Math.floor(s / 60))}:${pad(s % 60)}`
      + ` | SEI trung bình: ${num(h.averageSei, '%d')}`));
  } else {
    add(line('Phiên làm việc: --'));
  }

  // Both numbers come from this machine's own clock, so before the first measured frame they are not
  // numbers yet - and the phone's answer for "not yet" is the dash, never "nan".
  add(line(`Thời gian nhận diện: ${num(processingMs)} ms (${num(fps, '%.0f')} FPS)`));
  add(line(PRIVACY_NOTE, SMALL));
  // Same rule as hud.py: Material3 fixes the weight per style, so the headline and the SEI header are
  // Regular even though the preview column used to bold them. Deriving it here is what stops this leg
  // from emboldening a line the phone never emboldened.
  return out.map((l) => Object.assign({}, l, { bold: MEDIUM_STYLES.has(l.style) }));
}

function pad(n) {
  return String(Math.floor(n)).padStart(2, '0');
}
