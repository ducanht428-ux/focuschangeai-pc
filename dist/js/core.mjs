// Time-weighted sliding-window ratio, ported from app/src/main/java/com/focuschange/ai/FocusCore.kt
// (class WindowRatio) so the computer build and the phone build compute the SAME statistic.
//
// The constants below are not free choices: they are the values the phone runs with, taken from
// MainActivity.RATIO_BUCKETS / RATIO_MIN_SAMPLE_MS / RATIO_REF_FRAME_MS. Change one here and the
// two builds start disagreeing about the same student, which is worse than being slow.

/** Frame gap above this is a stall, not a measurement: nothing is accumulated for it. */
export const WINDOW_STALL_MS = 700;

/** Sixty one-second buckets = a 60 second window. */
export const RATIO_BUCKETS = 60;

/** Below this much sampled time the answer is "not measured", never "0 percent". */
export const RATIO_MIN_SAMPLE_MS = 3000;

/** Ceiling for one frame's contribution when the cadence is faster than refFrameMs. */
export const RATIO_CAP_FRAME_MS = 200;

/**
 * Reference frame cadence. Two different values are in use on the phone and passing the wrong one is
 * a real bug, not a rounding detail:
 *  - MainActivity builds the three PERCLOS windows with RATIO_REF_FRAME_MS = 33 explicitly;
 *  - EyeEngine builds the squint and two-eye windows as WindowRatio(60, 20000), which takes the
 *    Kotlin default capFrameMs / 3 = 66 (Long division, so 66 and not 66.67).
 * The default here mirrors the Kotlin default; PERCLOS callers must pass 33.
 */
export const RATIO_REF_FRAME_MS = 33;
export const RATIO_DEFAULT_REF_FRAME_MS = Math.floor(RATIO_CAP_FRAME_MS / 3);

export class WindowRatio {
  constructor(
    buckets = RATIO_BUCKETS,
    minSampleMs = RATIO_MIN_SAMPLE_MS,
    capFrameMs = RATIO_CAP_FRAME_MS,
    refFrameMs = RATIO_DEFAULT_REF_FRAME_MS,
  ) {
    this.buckets = buckets;
    this.minSampleMs = minSampleMs;
    this.capFrameMs = capFrameMs;
    this.refFrameMs = refFrameMs;
    this.flaggedMs = new Array(buckets).fill(0);
    this.totalMs = new Array(buckets).fill(0);
    this.bucketSecond = new Array(buckets).fill(-1);
    this.lastFrameMs = 0;
  }

  reset() {
    this.flaggedMs.fill(0);
    this.totalMs.fill(0);
    this.bucketSecond.fill(-1);
    this.lastFrameMs = 0;
  }

  /** Called while the signal is unusable so a time gap is not accumulated. */
  pause() {
    this.lastFrameMs = 0;
  }

  record(nowMs, flagged) {
    const rawDt = this.lastFrameMs === 0 ? 0 : nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    if (rawDt <= 0 || rawDt > WINDOW_STALL_MS) return;

    const dt = rawDt > this.refFrameMs
      ? this.refFrameMs
      : Math.min(rawDt, this.capFrameMs);
    if (dt === 0) return;

    const sec = Math.floor(nowMs / 1000);
    const idx = sec % this.buckets;

    if (this.bucketSecond[idx] !== sec) {
      this.bucketSecond[idx] = sec;
      this.flaggedMs[idx] = 0;
      this.totalMs[idx] = 0;
    }

    this.totalMs[idx] += dt;
    if (flagged) this.flaggedMs[idx] += dt;
  }

  /** Null means "not sampled enough yet" - the HUD must show a dash, not a fake zero. */
  percentOrNull(nowMs) {
    const nowSec = Math.floor(nowMs / 1000);
    let flagged = 0;
    let total = 0;

    for (let i = 0; i < this.buckets; i++) {
      const sec = this.bucketSecond[i];
      if (sec < 0) continue;
      const age = nowSec - sec;
      if (age >= 0 && age < this.buckets) {
        flagged += this.flaggedMs[i];
        total += this.totalMs[i];
      }
    }

    return total < this.minSampleMs ? null : (flagged * 100) / total;
  }

  /** Like percentOrNull but reads "not measured" as zero - for scoring, never for display. */
  percent(nowMs) {
    const v = this.percentOrNull(nowMs);
    return v === null ? 0 : v;
  }
}

/**
 * One Euro filter, ported from FocusCore.kt (class OneEuroFilter): smooths a noisy signal yet keeps
 * up during fast movement. The phone runs this in 32-bit Float; JavaScript arithmetic is 64-bit, so
 * a long chain of filtered frames can drift by roughly 1e-6. That is five orders of magnitude below
 * the camera noise it is meant to remove, so the port keeps plain doubles instead of fround()-ing
 * every operation.
 */
export class OneEuroFilter {
  constructor(minCutoff, beta, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.initialized = false;
    this.prevRaw = 0;
    this.prevFiltered = 0;
    this.prevDeriv = 0;
    this.prevTimeMs = 0;
  }

  reset() {
    this.initialized = false;
  }

  alpha(cutoff, dtSeconds) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dtSeconds);
  }

  filter(value, nowMs) {
    if (!this.initialized) {
      this.initialized = true;
      this.prevRaw = value;
      this.prevFiltered = value;
      this.prevDeriv = 0;
      this.prevTimeMs = nowMs;
      return value;
    }

    const dt = Math.max(nowMs - this.prevTimeMs, 1) / 1000;
    this.prevTimeMs = nowMs;

    const deriv = (value - this.prevRaw) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const derivHat = aD * deriv + (1 - aD) * this.prevDeriv;

    const cutoff = this.minCutoff + this.beta * Math.abs(derivHat);
    const a = this.alpha(cutoff, dt);
    const filtered = a * value + (1 - a) * this.prevFiltered;

    this.prevRaw = value;
    this.prevDeriv = derivHat;
    this.prevFiltered = filtered;
    return filtered;
  }
}
