// EyeEngine.kt ported line for line. This is the piece that decides "are the eyes closed", and it is
// the reason the two builds disagreed before: the computer used to compare a raw EAR against one
// fixed number (0.22), while the phone fuses geometry with the blendshape model, compensates head
// turn and downward gaze, rejects frames it cannot trust, adapts its thresholds to the noise of the
// person in front of the lens, and learns each student's own open-eye baseline during calibration.
//
// Nothing here is tuned independently. If a constant looks arbitrary it is because the phone runs
// with that value and the demo results were measured against it.

import { OneEuroFilter, WindowRatio } from './core.mjs';

export const R_UP = [161, 160, 159, 158, 157];
export const R_LOW = [163, 144, 145, 153, 154];
export const L_UP = [388, 387, 386, 385, 384];
export const L_LOW = [390, 373, 374, 380, 381];
export const R_OUT = 33;
export const R_IN = 133;
export const L_IN = 362;
export const L_OUT = 263;

export const CLOSE_O = 0.60;
export const OPEN_O = 0.78;
export const MIN_CLOSE_DWELL_MS = 40;
export const MIN_BLINK_MS = 25;
export const MAX_BLINK_MS = 1000;
export const INCOMPLETE_MIN_O = 0.45;
export const INCOMPLETE_MAX_DT_MS = 55;
export const ASYM_EXTRA_THRESHOLD = 0.25;
export const PARTIAL_LO = 0.45;
export const PARTIAL_HI = 0.80;
export const DEG2RAD = 0.017453292;
export const NOISY_ON = 0.12;
export const NOISY_OFF = 0.09;
export const NOISY_HOLD_MS = 10000;
export const SQUINT_ALERT_PCT = 40;
export const ASYM_ALERT_PCT = 50;
export const INCOMPLETE_ALERT_RATIO = 0.6;
export const RING = 20;

function dist(pts, a, b, w, h) {
  const dx = (pts[a].x - pts[b].x) * w;
  const dy = (pts[a].y - pts[b].y) * h;
  return Math.sqrt(dx * dx + dy * dy);
}

/** EyeEngine.kt:137 ear5 - 5 eyelid pairs, trimmed mean, divided by the eye width. */
export function ear5(pts, up, low, a, b, w, h) {
  let sum = 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < 5; i++) {
    const v = dist(pts, up[i], low[i], w, h);
    sum += v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const hor = dist(pts, a, b, w, h);
  if (hor < 1) return NaN;
  return ((sum - mn - mx) / 3) / hor;
}

/** EyeEngine.kt:161 percentile - the element at floor((n-1)*p), clamped into the list. */
export function percentile(list, p) {
  const s = list.slice().sort((x, y) => x - y);
  const idx = Math.min(Math.max(Math.floor((s.length - 1) * p), 0), s.length - 1);
  return s[idx];
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export class EyeEngine {
  constructor() {
    this.out = {
      valid: false,
      openness: 1,
      closed: false,
      closedStartMs: 0,
      blinkDurationMs: 0,
      blinkIncomplete: false,
      noisy: false,
      sigma: 0,
      squintPct: 0,
      asymPct: 0,
      incompleteRatio: NaN,
      squintAlert: false,
      asymAlert: false,
      incompleteAlert: false,
      usingBlendshapes: false,
    };

    this.tmp = new Float32Array(5);
    this.openFilter = new OneEuroFilter(4.0, 1.0);
    this.squintRatio = new WindowRatio(60, 20000);
    this.asymRatio = new WindowRatio(60, 30000);

    // Calibration.
    this.calE1 = [];
    this.calE2 = [];
    this.calBs = [];
    this.calAsym = [];
    this.ready = false;
    this.calBase1 = 0.3;
    this.calBase2 = 0.3;
    this.base1 = 0.3;
    this.base2 = 0.3;
    this.bsBase = 0.08;
    this.bsAsymBase = 0;
    this.closeO = CLOSE_O;
    this.openO = OPEN_O;

    // Blink state.
    this.closed = false;
    this.candStart = 0;
    this.candMin = 1;
    this.closedStart = 0;
    this.minDuring = 1;

    // Noise and rejection of broken frames.
    this.sigma = 0.03;
    this.noisyStart = 0;
    this.prevWr = 0;
    this.prevWl = 0;
    this.glitchStreak = 0;
    this.lastUpdateMs = 0;
    this.dtEma = 33;

    // Incomplete blinks.
    this.ring = new Array(RING).fill(false);
    this.ringIdx = 0;
    this.ringCount = 0;
  }

  /** EyeEngine.kt:80 setSensitivity. Level 3 ("Rat cao") was added to the phone after this port. */
  setSensitivity(level) {
    this.closeO = level === 0 ? 0.54 : level === 2 ? 0.66 : level === 3 ? 0.70 : CLOSE_O;
    this.openO = this.closeO + 0.18;
  }

  /**
   * EyeEngine.baseline_ear: the neutral opening ratio learned for this person, averaged over the two
   * eyes. The calibration line prints this. The closing threshold next to it on the phone is in the
   * phone's own EAR units while this engine gates on a normalised openness ratio, so there is no
   * matching number to print there and the HUD leaves that slot as a dash.
   */
  baselineEar() {
    return this.ready ? (this.base1 + this.base2) / 2 : NaN;
  }

  reset() {
    this.calE1 = [];
    this.calE2 = [];
    this.calBs = [];
    this.calAsym = [];
    this.ready = false;
    this.sigma = 0.03;
    this.noisyStart = 0;
    this.ringIdx = 0;
    this.ringCount = 0;
    this.squintRatio.reset();
    this.asymRatio.reset();
    this.pause();
  }

  /** Face lost or stream restarted: wipes the instant state, keeps the calibration. */
  pause() {
    this.closed = false;
    this.candStart = 0;
    this.openFilter.reset();
    this.squintRatio.pause();
    this.asymRatio.pause();
    this.prevWr = 0;
    this.prevWl = 0;
    this.glitchStreak = 0;
    this.lastUpdateMs = 0;
    this.out.valid = false;
    this.out.closed = false;
  }

  addCalibrationSample(pts, w, h, bs) {
    const e1 = ear5(pts, R_UP, R_LOW, R_OUT, R_IN, w, h);
    const e2 = ear5(pts, L_UP, L_LOW, L_IN, L_OUT, w, h);
    if (Number.isNaN(e1) || Number.isNaN(e2)) return;
    this.calE1.push(e1);
    this.calE2.push(e2);
    if (bs !== null && bs !== undefined) {
      this.calBs.push((bs[0] + bs[1]) / 2);
      this.calAsym.push(Math.abs(bs[0] - bs[1]));
    }
  }

  /**
   * EyeEngine.kt:212 finishCalibration - the 70th percentile baseline, dropping the blink and squint
   * frames that slipped into the calibration set. scale mixes in what the habit profile already
   * learned (on the computer there is no profile yet, so the caller passes 1).
   */
  finishCalibration(scale) {
    if (this.calE1.length < 5) {
      this.ready = false;
      return;
    }
    this.calBase1 = percentile(this.calE1, 0.70) * scale;
    this.calBase2 = percentile(this.calE2, 0.70) * scale;
    this.base1 = this.calBase1;
    this.base2 = this.calBase2;
    this.bsBase = this.calBs.length >= 5 ? clamp(percentile(this.calBs, 0.5), 0, 0.5) : 0.08;
    this.bsAsymBase = this.calAsym.length >= 5 ? clamp(percentile(this.calAsym, 0.5), 0, 0.3) : 0;
    this.ready = true;
    this.sigma = 0.03;
    this.noisyStart = 0;
    this.ringIdx = 0;
    this.ringCount = 0;
    this.squintRatio.reset();
    this.asymRatio.reset();
    this.pause();
  }

  recordBlink(incomplete) {
    this.ring[this.ringIdx] = incomplete;
    this.ringIdx = (this.ringIdx + 1) % RING;
    if (this.ringCount < RING) this.ringCount++;
  }

  incompleteRatio() {
    if (this.ringCount < 8) return NaN;
    let n = 0;
    for (let i = 0; i < this.ringCount; i++) if (this.ring[i]) n++;
    return n / this.ringCount;
  }

  /**
   * EyeEngine.kt:256 clearConclusions - this frame supports NO conclusion about the eyes, so the
   * numbers derived from earlier frames must be wiped as well. sigma becomes NaN, not 0: an empty
   * reading means "not measurable" while 0 would read as "wide open, clean signal".
   */
  clearConclusions(o) {
    o.squintPct = 0;
    o.asymPct = 0;
    o.incompleteRatio = NaN;
    o.squintAlert = false;
    o.asymAlert = false;
    o.incompleteAlert = false;
    o.noisy = false;
    o.sigma = NaN;
  }

  markInvalid(o, closedState) {
    o.valid = false;
    o.closed = closedState;
    this.clearConclusions(o);
  }

  update(pts, w, h, nowMs, yawDev, pitchDev, gazeVDev, bs, poseOk) {
    const o = this.out;
    o.blinkDurationMs = 0;
    o.blinkIncomplete = false;
    o.usingBlendshapes = bs !== null && bs !== undefined;

    if (!this.ready) {
      this.markInvalid(o, false);
      return o;
    }

    const e1 = ear5(pts, R_UP, R_LOW, R_OUT, R_IN, w, h);
    const e2 = ear5(pts, L_UP, L_LOW, L_IN, L_OUT, w, h);
    const wr = dist(pts, R_OUT, R_IN, w, h);
    const wl = dist(pts, L_IN, L_OUT, w, h);

    if (this.lastUpdateMs !== 0) {
      const dtFrame = nowMs - this.lastUpdateMs;
      if (dtFrame >= 1 && dtFrame <= 300) this.dtEma = this.dtEma * 0.95 + dtFrame * 0.05;
    }
    this.lastUpdateMs = nowMs;

    // 1) Reject frames where landmarks jump (glasses glare or a one-frame tracking loss).
    let glitch = Number.isNaN(e1) || Number.isNaN(e2);
    if (!glitch && this.prevWr > 0 && this.prevWl > 0) {
      const rr = wr / this.prevWr;
      const rl = wl / this.prevWl;
      if (rr > 1.3 || rr < 0.77 || rl > 1.3 || rl < 0.77) glitch = true;
    }
    if (glitch) {
      this.glitchStreak++;
      if (this.glitchStreak > 8) {
        this.prevWr = 0;
        this.prevWl = 0;
        this.glitchStreak = 0;
      }
      this.markInvalid(o, this.closed);
      return o;
    }
    this.glitchStreak = 0;
    this.prevWr = wr;
    this.prevWl = wl;

    // 2) Angle too oblique or weak signal: no conclusion about the eye state.
    if (!poseOk) {
      this.closed = false;
      this.candStart = 0;
      this.openFilter.reset();
      this.markInvalid(o, false);
      return o;
    }

    // 3) Compensated geometric openness: foreshortening on head turn, lid drop when looking down.
    const cosY = Math.cos(Math.min(Math.abs(yawDev), 50) * 0.9 * DEG2RAD);
    const down = Math.max(pitchDev, 0) * 0.006 + Math.max(gazeVDev, 0) * 0.5;
    const expected = clamp(1 - down, 0.7, 1);
    const c1 = (e1 * cosY) / expected;
    const c2 = (e2 * cosY) / expected;
    const og1 = clamp(c1 / this.base1, 0, 1.5);
    const og2 = clamp(c2 / this.base2, 0, 1.5);
    // The 2026-11-01 eye definition: openness is the BETTER-OPENED eye, not the mean of the two. One
    // shut eye used to read as half-closed and hid a real closure behind the other eye's openness;
    // the phone and the class camera both take the max now. This steps PERCLOS and the squint ratios
    // DOWN at install, so data recorded before that date is not 1:1 comparable with these numbers.
    const og = Math.max(og1, og2);

    // 4) Blendshapes and fusion, with a disagreement check between the two sources.
    let fused = og;
    let squintBs = 0;
    let asymBs = 0;
    if (o.usingBlendshapes) {
      const blink = (bs[0] + bs[1]) / 2;
      const ob = clamp(1 - (blink - this.bsBase) / Math.max(1 - this.bsBase, 0.5), 0, 1.3);
      fused = Math.abs(og - ob) > 0.45
        ? 0.8 * ob + 0.2 * og
        : 0.65 * ob + 0.35 * og;
      squintBs = (bs[2] + bs[3]) / 2;
      asymBs = Math.abs(bs[0] - bs[1]) - this.bsAsymBase;
    }

    // 5) Time filtering and the noise estimate taken while the eye is steadily open.
    const f = this.openFilter.filter(fused, nowMs);
    if (!this.closed && f > 0.85) {
      this.sigma = this.sigma * 0.98 + Math.abs(fused - f) * 1.25 * 0.02;
    }
    this.sigma = clamp(this.sigma, 0, 0.3);

    if (this.sigma > NOISY_ON) {
      if (this.noisyStart === 0) this.noisyStart = nowMs;
    } else if (this.sigma < NOISY_OFF) {
      this.noisyStart = 0;
    }
    const noisy = this.noisyStart !== 0 && nowMs - this.noisyStart >= NOISY_HOLD_MS;

    // 6) Self-adapting thresholds: the noisier the signal, the stricter, to avoid false blinks.
    const closeThr = clamp(this.closeO - 1.5 * this.sigma, 0.40, this.closeO);
    const openThr = Math.min(Math.max(closeThr + 0.12, this.openO - this.sigma), 0.88);

    // 7) Real-time blink state machine.
    if (!this.closed) {
      if (f < closeThr) {
        if (this.candStart === 0) {
          this.candStart = nowMs;
          this.candMin = f;
        }
        this.candMin = Math.min(this.candMin, f);
        const dwell = nowMs - this.candStart;
        if (dwell >= MIN_CLOSE_DWELL_MS || f < closeThr - 0.15) {
          this.closed = true;
          this.closedStart = this.candStart;
          this.minDuring = this.candMin;
        }
      } else {
        this.candStart = 0;
      }
    } else {
      this.minDuring = Math.min(this.minDuring, f);
      if (f > openThr) {
        const dur = nowMs - this.closedStart;
        if (dur >= MIN_BLINK_MS && dur <= MAX_BLINK_MS) {
          o.blinkDurationMs = dur;
          if (this.dtEma <= INCOMPLETE_MAX_DT_MS) {
            o.blinkIncomplete = this.minDuring > INCOMPLETE_MIN_O;
            this.recordBlink(o.blinkIncomplete);
          }
        }
        this.closed = false;
        this.candStart = 0;
      }
    }

    // 8) Discomfort indicators: prolonged squinting, the two eyes opening unevenly.
    let partial = !this.closed && f >= PARTIAL_LO && f < PARTIAL_HI;
    if (!partial && !this.closed && squintBs > 0.45 && f < 0.9) partial = true;
    this.squintRatio.record(nowMs, partial);

    const frontal = Math.abs(yawDev) < 15;
    const asymFlag = o.usingBlendshapes
      ? asymBs > ASYM_EXTRA_THRESHOLD
      : Math.abs(og1 - og2) > 0.35;
    this.asymRatio.record(nowMs, frontal && !this.closed && f > 0.35 && asymFlag);

    const sq = this.squintRatio.percent(nowMs);
    const asym = this.asymRatio.percent(nowMs);
    const inc = this.incompleteRatio();

    // 9) Slowly tracked baseline: follows changing light but must not drift with fatigue.
    if (f > 0.8 && !this.closed) {
      if (c1 > this.base1) {
        if (c1 < this.base1 * 1.35) this.base1 += 0.02 * (c1 - this.base1);
      } else if (c1 > this.base1 * 0.85) {
        this.base1 -= 0.0004 * (this.base1 - c1);
      }
      if (c2 > this.base2) {
        if (c2 < this.base2 * 1.35) this.base2 += 0.02 * (c2 - this.base2);
      } else if (c2 > this.base2 * 0.85) {
        this.base2 -= 0.0004 * (this.base2 - c2);
      }
      this.base1 = clamp(this.base1, this.calBase1 * 0.85, this.calBase1 * 1.25);
      this.base2 = clamp(this.base2, this.calBase2 * 0.85, this.calBase2 * 1.25);
    }

    o.valid = true;
    o.openness = f;
    o.closed = this.closed;
    o.closedStartMs = this.closedStart;
    o.sigma = this.sigma;
    o.noisy = noisy;
    o.squintPct = sq;
    o.asymPct = asym;
    o.incompleteRatio = inc;
    o.squintAlert = sq >= SQUINT_ALERT_PCT;
    o.asymAlert = asym >= ASYM_ALERT_PCT;
    o.incompleteAlert = !Number.isNaN(inc) && inc >= INCOMPLETE_ALERT_RATIO;
    return o;
  }
}

/**
 * MainActivity.kt:4913 extractBlend - the five coefficients the phone reads, in the order EyeEngine
 * expects: [left blink, right blink, left squint, right squint, jaw open].
 * Null when the model was not asked for blendshapes, which puts the engine in geometry-only mode.
 */
export function extractBlend(result) {
  const list = result && result.faceBlendshapes && result.faceBlendshapes[0];
  if (!list) return null;

  let blinkL = -1;
  let blinkR = -1;
  let squintL = 0;
  let squintR = 0;
  let jawOpen = 0;
  for (const c of list.categories) {
    switch (c.categoryName) {
      case 'eyeBlinkLeft': blinkL = c.score; break;
      case 'eyeBlinkRight': blinkR = c.score; break;
      case 'eyeSquintLeft': squintL = c.score; break;
      case 'eyeSquintRight': squintR = c.score; break;
      case 'jawOpen': jawOpen = c.score; break;
      default: break;
    }
  }
  return blinkL < 0 || blinkR < 0 ? null : [blinkL, blinkR, squintL, squintR, jawOpen];
}
