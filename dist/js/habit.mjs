// Per-student habit profile - the "tự học" of the phone, ported from
// edge-server/focusedge/habit.py (itself a port of HabitModel.kt) and HabitAndroid.kt:80-126.
//
// Pure numbers, no browser API: everything that touches localStorage lives in index.html, so this file
// runs under node in _dev/ and can be replayed against the Python implementation on the same stream.
// That is the only way to know the browser learned the same thing the class camera would have.
//
// Two questions, same as the other legs:
//   * "how did this session go"                       -> HabitSummary (one row per finished session)
//   * "what is normal for this student right now"      -> HabitBaseline / ToleranceBand
// Nothing here raises an alert. The band is a description; alerts keep their own thresholds.

import { RunningStat } from './situation.mjs';
import { PERSONAL_SEI_MIN_SPREAD } from './params.mjs';

// HabitFeature in constants.py / HabitModel.kt. Index order is the contract with the stored JSON -
// never reorder, or an old profile is read as a different set of numbers.
export const HF = {
  BPM: 0,
  BLINK_MS: 1,
  DIST: 2,
  YAW: 3,
  PITCH: 4,
  GAZE_H: 5,
  GAZE_V: 6,
  MAR: 7,
  BFR: 8,
  EAR: 9,
  PERCLOS: 10,
  SEI: 11,
};
export const HF_COUNT = 12;

// LO/HI are the per-observation clip (winsorize) so one noisy frame cannot drag a profile off.
export const HF_LO = [0.0, 40.0, 10.0, -60.0, -60.0, -0.5, -0.6, 0.0, 0.1, 0.0, 0.0, 0.0];
export const HF_HI = [60.0, 1000.0, 150.0, 60.0, 60.0, 0.5, 0.6, 1.2, 1.5, 0.6, 100.0, 100.0];
export const HF_MIN_SPREAD = [2.0, 20.0, 3.0, 2.0, 2.0, 0.02, 0.03, 0.02, 0.01, 0.01, 1.5, 3.0];
export const HF_KEYS = ['blink_bpm', 'avg_blink_ms', 'distance_cm', 'yaw_deg', 'pitch_deg', 'gaze_h',
  'gaze_v', 'mar', 'bfr', 'ear', 'perclos_p60', 'sei'];
// The eight features checked two-sided on every frame.
export const HF_BAND_FEATURES = [HF.BPM, HF.YAW, HF.PITCH, HF.GAZE_H, HF.GAZE_V, HF.MAR, HF.PERCLOS, HF.SEI];

// HabitConfig in constants.py.
export const HC = {
  MIN_SESSION_MS: 2 * 60 * 1000,
  MIN_FACE_RATIO: 0.70,
  MIN_VALID_RATIO: 0.50,
  MIN_QUALITY: 60.0,
  MIN_SESSION_SEI: 40.0,
  MIN_SESSIONS: 5,
  MIN_TOTAL_MS: 10 * 60 * 1000,
  MAX_SESSIONS: 40,
  MIN_FRAMES_PER_FEATURE: 30,
  RECENCY_DECAY: 0.9,
  MAX_WEIGHT_MINUTES: 30.0,
  MAX_FRAME_GAP_MS: 700,
  BAND_K: 2.5,
};

const BAND_BELOW = 0;
const BAND_IN = 1;
const BAND_ABOVE = 2;
const BAND_UNKNOWN = -1;

const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);

/**
 * median() used by HabitProfile.baseline(): the element at index n//2 of the SORTED list.
 *
 * That is not the textbook median - for an even count the two middle values are not averaged. The
 * outlier filter below picks which sessions are trusted, so "correcting" this to the average would
 * change which sessions a profile keeps and the two legs would stop agreeing on a noisy student.
 */
function upperMedian(sorted) {
  return sorted[Math.floor(sorted.length / 2)];
}

/** position() of ToleranceBand in habit.py. */
export class ToleranceBand {
  constructor(mean, min, max) {
    this.mean = mean;
    this.min = min;
    this.max = max;
  }

  position(value) {
    if (!isNum(value)) return BAND_UNKNOWN;
    if (value < this.min) return BAND_BELOW;
    if (value > this.max) return BAND_ABOVE;
    return BAND_IN;
  }
}

/** HabitSession in habit.py: the accumulator for the run that is happening right now. */
export class HabitSession {
  constructor(sessionId) {
    this.id = sessionId;
    this.sensitivityLevel = -1;
    this.activeMs = 0;
    this.faceMs = 0;
    this.validMs = 0;
    this._stats = Array.from({ length: HF_COUNT }, () => new RunningStat());
    this._quality = new RunningStat();
    this._bands = new Array(HF_COUNT).fill(null);
    this._bandIn = new Array(HF_COUNT).fill(0);
    this._bandBelow = new Array(HF_COUNT).fill(0);
    this._bandAbove = new Array(HF_COUNT).fill(0);
    this._lastTickMs = 0;
  }

  tick(nowMs, faceVisible, valid) {
    const dt = this._lastTickMs === 0 ? 0 : nowMs - this._lastTickMs;
    this._lastTickMs = nowMs;
    if (dt <= 0) return;
    this.activeMs += dt;
    // A gap wider than this is a stall, not a reading: the face was not absent for 700 ms, the page
    // was backgrounded or the tab was frozen. Counting it as valid time would invent monitoring.
    if (dt > HC.MAX_FRAME_GAP_MS) return;
    if (faceVisible) this.faceMs += dt;
    if (valid) this.validMs += dt;
  }

  observe(feature, value) {
    // Exactly habit.py:116 - only +Infinity is refused. A -Infinity still clamps up to LO, which is
    // what the Python does, and a "safer" Number.isFinite() here would drop samples the other leg keeps.
    if (value === null || value === undefined || Number.isNaN(value) || value === Infinity) return;
    const v = Math.max(HF_LO[feature], Math.min(HF_HI[feature], value));
    this._stats[feature].add(v);
  }

  setBands(base, features) {
    for (const f of features) this._bands[f] = base.band(f);
  }

  observeBand(feature, value) {
    const band = this._bands[feature];
    if (band === null || value === null || value === undefined) return BAND_UNKNOWN;
    const pos = band.position(value);
    if (pos === BAND_IN) this._bandIn[feature]++;
    else if (pos === BAND_BELOW) this._bandBelow[feature]++;
    else if (pos === BAND_ABOVE) this._bandAbove[feature]++;
    return pos;
  }

  addQuality(q) {
    this._quality.add(q);
  }

  bandCoverage(features) {
    return features.filter((f) => this._bands[f] !== null).length;
  }

  bandOutcomes() {
    const out = [];
    for (const f of HF_BAND_FEATURES) {
      const band = this._bands[f];
      if (band === null) continue;
      const n = this._bandIn[f] + this._bandBelow[f] + this._bandAbove[f];
      if (n === 0) continue;
      out.push({
        feature: f, mean: band.mean, min: band.min, max: band.max, samples: n,
        below: this._bandBelow[f], above: this._bandAbove[f],
      });
    }
    return out;
  }

  toSummary() {
    const mean = [];
    const std = [];
    const count = [];
    for (let f = 0; f < HF_COUNT; f++) {
      mean.push(this._stats[f].mean);
      std.push(this._stats[f].std());
      count.push(this._stats[f].n);
    }
    let bIn = 0;
    let bBelow = 0;
    let bAbove = 0;
    for (const f of HF_BAND_FEATURES) {
      bIn += this._bandIn[f];
      bBelow += this._bandBelow[f];
      bAbove += this._bandAbove[f];
    }
    return {
      id: this.id,
      validMs: this.validMs,
      faceRatio: this.activeMs > 0 ? this.faceMs / this.activeMs : 0,
      validRatio: this.faceMs > 0 ? this.validMs / this.faceMs : 0,
      quality: this._quality.mean,
      qualityCount: this._quality.n,
      mean,
      std,
      count,
      bandIn: bIn,
      bandBelow: bBelow,
      bandAbove: bAbove,
      sensitivityLevel: this.sensitivityLevel,
    };
  }
}

/** HabitBaseline in habit.py - the numbers learned from the sessions already stored. */
export class HabitBaseline {
  constructor(means, spreads, ok) {
    this._means = means;
    this._spreads = spreads;
    this._ok = ok;
  }

  mean(f) { return this._ok[f] ? this._means[f] : null; }

  spread(f) { return this._ok[f] ? this._spreads[f] : null; }

  /** threshold() in HabitModel.kt:418: |mean| + k * spread, clamped into [lo, hi].
   *
   * The absolute value is deliberate: a student who habitually turns 5 degrees left and one who turns
   * 5 degrees right get the same gate, because the alert is about leaving the frontal pose, not about
   * which way. */
  threshold(f, k, lo, hi) {
    if (!this._ok[f]) return null;
    return Math.max(lo, Math.min(hi, Math.abs(this._means[f]) + k * this._spreads[f]));
  }

  band(f, k = HC.BAND_K) {
    if (!this._ok[f]) return null;
    const half = k * this._spreads[f];
    return new ToleranceBand(
      this._means[f],
      Math.max(HF_LO[f], this._means[f] - half),
      Math.min(HF_HI[f], this._means[f] + half),
    );
  }
}

/** HabitProfile in habit.py: the stored history of one student, on this machine only. */
export class HabitProfile {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sessions = [];
    this.distanceScale = NaN;
    this.calRawDistanceCm = NaN;
    this.calibratedAtMs = 0;
  }

  hasCalibration() {
    return Number.isFinite(this.distanceScale) && this.distanceScale > 0;
  }

  sessionCount() { return this.sessions.length; }

  totalValidMs() { return this.sessions.reduce((a, s) => a + s.validMs, 0); }

  isReady() {
    return this.sessions.length >= HC.MIN_SESSIONS && this.totalValidMs() >= HC.MIN_TOTAL_MS;
  }

  confidence() {
    if (!this.isReady()) return 0;
    const raw = (this.sessions.length - HC.MIN_SESSIONS + 1) / 5.0;
    return Math.max(0.2, Math.min(1.0, raw));
  }

  /**
   * Why this session does not belong in the profile - HabitModel.kt:493-505, in the phone's own words.
   *
   * habit.py carries shortened ASCII copies of these five sentences because its version is uploaded to
   * Firestore, where the phone's key already exists. Here the string is only ever read on screen, so it
   * uses what the phone actually shows its user.
   */
  ineligibleReason(s) {
    if (s.validMs < HC.MIN_SESSION_MS) return `chưa đủ ${HC.MIN_SESSION_MS / 60000} phút hợp lệ`;
    if (s.faceRatio < HC.MIN_FACE_RATIO) return 'ít khi thấy khuôn mặt';
    if (s.validRatio < HC.MIN_VALID_RATIO) return 'tín hiệu hoặc tư thế không ổn định, hoặc mất tập trung kéo dài';
    if (s.quality < HC.MIN_QUALITY) return 'chất lượng tín hiệu thấp (ánh sáng, khoảng cách)';
    if (s.count[HF.SEI] > 0 && s.mean[HF.SEI] < HC.MIN_SESSION_SEI) {
      return 'mức tập trung trung bình thấp, không đại diện cho thói quen học';
    }
    return null;
  }

  commit(s) {
    const pos = this.sessions.findIndex((x) => x.id === s.id);
    if (this.ineligibleReason(s) !== null) {
      if (pos >= 0) {
        this.sessions.splice(pos, 1);
        return true;
      }
      return false;
    }
    if (pos >= 0) this.sessions[pos] = s;
    else this.sessions.push(s);
    while (this.sessions.length > HC.MAX_SESSIONS) this.sessions.shift();
    return true;
  }

  /** baseline() in habit.py, loop for loop - see _dev/habit-check.mjs for the replay that proves it. */
  baseline() {
    const means = new Array(HF_COUNT).fill(0);
    const spreads = new Array(HF_COUNT).fill(0);
    const ok = new Array(HF_COUNT).fill(false);
    const n = this.sessions.length;
    for (let f = 0; f < HF_COUNT; f++) {
      const minCount = f === HF.EAR ? 1 : HC.MIN_FRAMES_PER_FEATURE;
      const idx = [];
      for (let i = 0; i < n; i++) if (this.sessions[i].count[f] >= minCount) idx.push(i);
      if (idx.length === 0) continue;
      let keep = idx;
      if (idx.length >= 5) {
        const vals = idx.map((i) => this.sessions[i].mean[f]).sort((a, b) => a - b);
        const med = upperMedian(vals);
        const dev = idx.map((i) => Math.abs(this.sessions[i].mean[f] - med)).sort((a, b) => a - b);
        const mad = Math.max(upperMedian(dev), HF_MIN_SPREAD[f] * 0.5);
        const limit = 3.5 * 1.4826 * mad;
        const filtered = idx.filter((i) => Math.abs(this.sessions[i].mean[f] - med) <= limit);
        if (filtered.length >= 3) keep = filtered;
      }
      const w = [];
      let sumW = 0;
      let sumM = 0;
      for (const i of keep) {
        const s = this.sessions[i];
        const age = n - 1 - i;
        const minutes = Math.min(s.validMs / 60000.0, HC.MAX_WEIGHT_MINUTES);
        const wi = Math.max(minutes, 0.5) * Math.pow(HC.RECENCY_DECAY, age);
        w.push(wi);
        sumW += wi;
        sumM += wi * s.mean[f];
      }
      const mean = sumM / sumW;
      let between = 0;
      let within = 0;
      for (let j = 0; j < keep.length; j++) {
        const s = this.sessions[keep[j]];
        const d = s.mean[f] - mean;
        between += w[j] * d * d;
        within += w[j] * s.std[f] * s.std[f];
      }
      means[f] = mean;
      spreads[f] = Math.max(Math.sqrt(between / sumW + within / sumW), HF_MIN_SPREAD[f]);
      ok[f] = true;
    }
    return new HabitBaseline(means, spreads, ok);
  }
}

/**
 * applyPersonalParams in MainActivity.kt:2465, threshold for threshold (person_pipeline.py:375).
 *
 * `mix` weights the learned value by the profile's confidence, and confidence is 0 until the profile
 * holds MIN_SESSIONS sessions and MIN_TOTAL_MS of valid time - so a face this machine has never seen
 * keeps the plain constants, which is the same answer the phone gives a stranger. The clamps come from
 * the phone too: a runaway spread cannot push the look-away gate past 30 degrees or PERCLOS past 25 %.
 *
 * `count` is the phone's personalThresholdCount: how many of the eight actually got blended. The HUD
 * says "%d/%d ngưỡng riêng" with it, so a guessed count would be a printed lie.
 */
export function personalThresholds(profile, base) {
  const out = {
    lookYaw: base.lookYaw,
    lookPitch: base.lookPitch,
    gazeH: base.gazeH,
    gazeV: base.gazeV,
    blinkLow: base.blinkLow,
    blinkHigh: base.blinkHigh,
    perclos: base.perclos,
    mar: base.mar,
    personalSeiMean: null,
    personalSeiSpread: null,
    count: 0,
    blend: 0,
  };
  if (!profile) return out;
  const learned = profile.baseline();
  const c = profile.confidence();
  if (!learned || c <= 0) return out;
  out.blend = c;

  let count = 0;
  const mix = (def, personal) => {
    if (personal === null || personal === undefined) return def;
    count++;
    return def * (1.0 - c) + personal * c;
  };

  out.lookYaw = mix(base.lookYaw, learned.threshold(HF.YAW, 2.5, 12.0, 30.0));
  out.lookPitch = mix(base.lookPitch, learned.threshold(HF.PITCH, 2.5, 12.0, 30.0));
  out.gazeH = mix(base.gazeH, learned.threshold(HF.GAZE_H, 2.5, 0.10, 0.30));
  out.gazeV = mix(base.gazeV, learned.threshold(HF.GAZE_V, 2.5, 0.14, 0.40));

  const bpmMean = learned.mean(HF.BPM);
  const bpmSpread = learned.spread(HF.BPM);
  if (bpmMean !== null && bpmSpread !== null) {
    out.blinkLow = mix(base.blinkLow, Math.max(4.0, Math.min(12.0, bpmMean - 2.0 * bpmSpread)));
    out.blinkHigh = mix(base.blinkHigh, Math.max(24.0, Math.min(40.0, bpmMean + 2.0 * bpmSpread)));
  }

  const pMean = learned.mean(HF.PERCLOS);
  const pSpread = learned.spread(HF.PERCLOS);
  if (pMean !== null && pSpread !== null) {
    out.perclos = mix(base.perclos, Math.max(10.0, Math.min(25.0, pMean + 3.0 * pSpread)));
  }

  const mMean = learned.mean(HF.MAR);
  const mSpread = learned.spread(HF.MAR);
  if (mMean !== null && mSpread !== null) {
    out.mar = mix(base.mar, Math.max(0.45, Math.min(0.70, mMean + 5.0 * mSpread)));
  }

  const sMean = learned.mean(HF.SEI);
  const sSpread = learned.spread(HF.SEI);
  if (sMean !== null && sSpread !== null) {
    out.personalSeiMean = sMean;
    out.personalSeiSpread = Math.max(sSpread, PERSONAL_SEI_MIN_SPREAD);
  }
  out.count = count;
  return out;
}

/**
 * blendEarWithHabit, MainActivity.kt:2619-2631 - the phone's other half of "tự học": what the eye
 * engine calls "closed" is pulled toward this student's usual openness.
 *
 * Returns the factor BOTH calibration baselines must be multiplied by, or 1 when there is nothing to
 * blend. The 0.7/1.3 guard is what stops a new pair of glasses or a different room from being averaged
 * into the old one; the weight is capped at 35 % so the session's own measurement still dominates.
 */
export function earBlendFactor(profile, baselineEar1, baselineEar2) {
  if (!profile || !profile.isReady()) return 1;
  const learned = profile.baseline().mean(HF.EAR);
  if (learned === null) return 1;
  const current = (baselineEar1 + baselineEar2) / 2;
  if (!(current > 0)) return 1;
  const ratio = learned / current;
  if (ratio < 0.7 || ratio > 1.3) return 1;
  const w = 0.35 * profile.confidence();
  return (1 - w) + w * ratio;
}

const SENSITIVITY_NAMES = ['thấp', 'vừa', 'cao', 'rất cao'];

function pad2(v) { return v < 10 ? '0' + v : String(v); }

/** HabitAndroid.kt:79-126 - historyText: the session list and the SEI trend the phone prints. */
export function historyText(profile, maxLines) {
  const sessions = profile.sessions;
  if (sessions.length === 0) return 'Chưa có phiên nào đạt chuẩn.';
  const out = [];
  const from = Math.max(0, sessions.length - maxLines);
  for (let i = sessions.length - 1; i >= from; i--) {
    const s = sessions[i];
    const d = new Date(s.id);
    let line = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    line += ` - ${Math.floor(s.validMs / 60000)} phút hợp lệ`;
    if (s.count[HF.SEI] > 0) line += `, SEI TB ${Math.round(s.mean[HF.SEI])}`;
    if (s.count[HF.BPM] > 0) line += `, chớp ${Math.round(s.mean[HF.BPM])}/phút`;
    // FocusCore.kt:512-518 prints "không rõ" for a level outside the four known ones, and the guard in
    // HabitAndroid.kt:96 is only ">= 0". Dropping the clause instead would make a hand-edited file read
    // as "this session had no sensitivity setting", which is what -1 already says.
    if (s.sensitivityLevel >= 0) {
      line += `, độ nhạy ${SENSITIVITY_NAMES[s.sensitivityLevel] || 'không rõ'}`;
    }
    out.push(line);
  }

  const avgSei = (fromIdx, toIdx) => {
    // Clamped exactly like HabitModel.kt:534-535. A four-session profile asks for avgSei(-2, 1), and
    // without the clamp this loop indexes sessions[-2] - undefined - and throws on the sentence whose
    // whole job is to say "not enough sessions yet".
    const lo = Math.max(0, fromIdx);
    const hi = Math.min(sessions.length, toIdx);
    let sum = 0;
    let n = 0;
    for (let i = lo; i < hi; i++) {
      if (sessions[i].count[HF.SEI] > 0) {
        sum += sessions[i].mean[HF.SEI];
        n++;
      }
    }
    return n > 0 ? [sum / n, n] : null;
  };

  if (sessions.length >= 4) {
    const n = sessions.length;
    const recent = avgSei(n - 3, n);
    const previous = avgSei(n - 6, n - 3);
    if (recent && previous && recent[1] >= 2 && previous[1] >= 2) {
      const diff = recent[0] - previous[0];
      const word = diff >= 5 ? 'đang tăng' : (diff <= -5 ? 'đang giảm' : 'ổn định');
      out.push(`Xu hướng SEI: ${word} (${diff >= 0 ? '+' : ''}${Math.round(diff)} điểm: ${recent[1]} phiên gần nhất so với ${previous[1]} phiên trước đó).`);
    } else {
      // While too few sessions exist, no claim about a "trend" is allowed at all.
      out.push('Chưa đủ số phiên đạt chuẩn để kết luận xu hướng SEI.');
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// localStorage shape. Keys are the phone's own short names (HabitAndroid.kt:23-41) so a profile
// written here can be read by the same tools, and a session written by the phone would parse here.
// ---------------------------------------------------------------------------

/** SessionSummary.toJson in HabitAndroid.kt:23. */
export function summaryToJson(s) {
  return {
    id: s.id, validMs: s.validMs, fr: s.faceRatio, vr: s.validRatio, q: s.quality,
    m: s.mean, s: s.std, n: s.count, qn: s.qualityCount,
    bi: s.bandIn, bb: s.bandBelow, ba: s.bandAbove, sl: s.sensitivityLevel,
  };
}

/**
 * SessionSummary.fromJson in HabitAndroid.kt:43 - returns null for a record it cannot trust.
 *
 * The three arrays are read strictly, the way Kotlin's getDouble/getInt throw: a record with a hole in
 * it would otherwise be learned as a zero, and a zero SEI mean is a statement about the student.
 */
export function summaryFromJson(o) {
  if (!o || !Array.isArray(o.m) || !Array.isArray(o.s) || !Array.isArray(o.n)) return null;
  if (o.m.length !== HF_COUNT || o.s.length !== HF_COUNT || o.n.length !== HF_COUNT) return null;
  const strict = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const id = strict(o.id);
  const validMs = strict(o.validMs);
  const fr = strict(o.fr);
  const vr = strict(o.vr);
  const q = strict(o.q);
  if (id === null || validMs === null || fr === null || vr === null || q === null) return null;
  const mean = o.m.map(strict);
  const std = o.s.map(strict);
  const count = o.n.map(strict);
  if (mean.some((v) => v === null) || std.some((v) => v === null) || count.some((v) => v === null)) {
    return null;
  }
  const int = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : d);
  return {
    id,
    validMs,
    faceRatio: fr,
    validRatio: vr,
    quality: q,
    mean,
    std,
    count: count.map((v) => Math.trunc(v)),
    // Files written before qn existed store no count. A session can only be IN a profile if it passed
    // the quality bar, so a stored positive mean is proof enough that samples existed; guessing 0 here
    // would blank the quality column for every old profile.
    qualityCount: int(o.qn, q > 0 ? 1 : 0),
    // Old records have no band counts. 0 samples is what actually happened - that session was never
    // scored against a band - and the day table reads that as "no data", never as "0 %".
    bandIn: int(o.bi, 0),
    bandBelow: int(o.bb, 0),
    bandAbove: int(o.ba, 0),
    // A record with no "sl" was written by a build that did not store the setting. -1 keeps that as
    // "unknown"; reading it as "vừa" would invent a measurement condition.
    sensitivityLevel: int(o.sl, -1),
  };
}

export function profileToJson(p) {
  return {
    id: p.id,
    name: p.name,
    distanceScale: Number.isFinite(p.distanceScale) ? p.distanceScale : null,
    calRawDistanceCm: Number.isFinite(p.calRawDistanceCm) ? p.calRawDistanceCm : null,
    calibratedAtMs: p.calibratedAtMs,
    sessions: p.sessions.map(summaryToJson),
  };
}

export function profileFromJson(o) {
  if (!o || typeof o.id !== 'string') return null;
  const p = new HabitProfile(o.id, typeof o.name === 'string' ? o.name : o.id);
  p.distanceScale = typeof o.distanceScale === 'number' ? o.distanceScale : NaN;
  p.calRawDistanceCm = typeof o.calRawDistanceCm === 'number' ? o.calRawDistanceCm : NaN;
  p.calibratedAtMs = typeof o.calibratedAtMs === 'number' ? o.calibratedAtMs : 0;
  const list = Array.isArray(o.sessions) ? o.sessions : [];
  for (const raw of list) {
    const s = summaryFromJson(raw);
    if (s) p.sessions.push(s);
  }
  return p;
}
