// SEI (Study Engagement Index) composite score, ported from edge-server/focusedge/sei.py, which is
// itself a line-for-line port of MainActivity.kt. Three implementations, one number: the same child
// sitting in front of the phone, the class camera and this page must reach the same score, or the
// comparison the project is built on is not a comparison.
//
// Nothing here owns a threshold - every gate arrives as an argument, because the phone's gates are
// personalised per student and the caller is the only place that knows which student this frame is.

import {
  FATIGUE_SMOOTHING,
  SEI_ANOMALY_CAP,
  SEI_CHRONIC_PENALTY,
  SEI_SMOOTHING,
  SEI_TOO_CLOSE_PENALTY,
  SEI_WATCH_PENALTY,
  W_BPM,
  W_DISTANCE,
  W_EYES,
  W_EXPRESSION,
  W_GAZE,
  W_POSTURE,
  clamp,
  clamp01,
  isFiniteNumber,
  MuscleSensitivity,
} from './params.mjs';

/**
 * Distance sub-score. None means the camera could not measure, and 70 is what the phone gives for
 * "unknown" - not 100, because an unmeasured distance must not read as a well-placed student.
 */
export function distanceScore(d, minSafeCm) {
  if (!isFiniteNumber(d)) return 70;
  if (d < minSafeCm) return (d / minSafeCm) * 50;
  if (d < 45) return 60 + ((d - minSafeCm) / 15) * 40;
  if (d <= 80) return 100;
  if (d <= 120) return 100 - ((d - 80) / 40) * 50;
  return 50;
}

/**
 * Eye sub-score from the current closed streak. Note the missing sensitivity factor: on the phone and
 * here, "eyes shut 1.5 s" means the same thing whatever the slider says, so the score keeps the raw
 * floor while the ALERT branch that uses the same fact is stretched by the slider.
 */
export function eyeScore(closedDurationMs, closedNow, drowsyMs) {
  if (closedNow && closedDurationMs >= drowsyMs) return 0;
  if (closedNow && closedDurationMs >= 500) return 40;
  if (closedNow) return 90;
  return 100;
}

export function bpmScore(bpm, reliable, thrBlinkLow, thrBlinkHigh) {
  if (!reliable) return 85;
  const lo = thrBlinkLow + 4;
  const hi = thrBlinkHigh - 5;
  if (bpm >= lo && bpm <= hi) return 100;
  if (bpm < lo) return 40 + (bpm / lo) * 60;
  return Math.max(30, 100 - ((bpm - hi) / 7) * 30);
}

export function headScore(yawDeg, pitchDeg, rollDeg, jitter) {
  const orientation = 100
    - clamp01(Math.abs(yawDeg) / 25) * 50
    - clamp01(Math.abs(pitchDeg) / 25) * 30
    - clamp01(Math.abs(rollDeg) / 25) * 20;
  const stability = 100 * (1 - clamp01(jitter / 0.05));
  return clamp(orientation * 0.7 + stability * 0.3, 0, 100);
}

export function gazeScore(available, eyesOpen, offH, offV, driftLong, thrGazeH, thrGazeV) {
  if (!available || !eyesOpen) return 85;
  const base = 100
    - clamp01(Math.abs(offH) / (thrGazeH * 1.5)) * 60
    - clamp01(Math.abs(offV) / (thrGazeV * 1.5)) * 40;
  if (driftLong) return Math.min(base, 30);
  return clamp(base, 0, 100);
}

export function expressionScore(yawnConfirmed, yawnsRecent, bfr, baseline, confused) {
  const mouthPenalty = yawnConfirmed ? 60 : Math.min(30, yawnsRecent * 10);
  const deficit = 1 - (baseline ? bfr / baseline : 1);
  const furrowMax = confused ? 30 : 20;
  const furrowPenalty = clamp01((deficit - 0.05) / 0.20) * furrowMax;
  return clamp(100 - mouthPenalty - furrowPenalty, 0, 100);
}

/**
 * MainActivity.frameAlpha: the smoothing coefficient for a frame that took frameDtMs, given the
 * reference coefficient measured at 30 fps. Without this the SEI would settle twice as fast on a
 * 15 fps laptop camera as on a 30 fps phone, which is a difference in the clock, not in the child.
 */
export function frameAlpha(perFrameAt30fps, frameDtMs) {
  const a = clamp(perFrameAt30fps, 0.001, 0.99);
  const tauMs = -33.3 / Math.log(1 - a);
  return clamp(1 - Math.exp(-frameDtMs / tauMs), 0, 1);
}

export class SeiTracker {
  constructor() {
    this.seiSum = 0;
    this.seiCount = 0;
    this.minSei = null;
    this._seiEma = 0;
    this._seiInitialized = false;
    this._fatigueEma = 0;
  }

  reset() {
    this.seiSum = 0;
    this.seiCount = 0;
    this.minSei = null;
    this._seiEma = 0;
    this._seiInitialized = false;
    this._fatigueEma = 0;
  }

  /**
   * @param {{posture:number, dist:number, gaze:number, eyes:number, blinkRate:number, expression:number}} c
   */
  rawFromComponents(c, distanceAlert, chronicLevel, frozen) {
    let raw = c.posture * W_POSTURE + c.dist * W_DISTANCE + c.gaze * W_GAZE
      + c.eyes * W_EYES + c.blinkRate * W_BPM + c.expression * W_EXPRESSION;
    if (distanceAlert) raw -= SEI_TOO_CLOSE_PENALTY;
    if (chronicLevel === 2) raw -= SEI_CHRONIC_PENALTY;
    else if (chronicLevel === 1) raw -= SEI_WATCH_PENALTY;
    if (frozen) raw = Math.min(raw, SEI_ANOMALY_CAP);
    return raw;
  }

  updateSei(raw, frameDtMs, sensSmooth = 1) {
    const target = clamp(raw, 0, 100);
    if (!this._seiInitialized) {
      this._seiInitialized = true;
      this._seiEma = target;
    } else {
      this._seiEma += (target - this._seiEma) * frameAlpha(Math.min(0.9, SEI_SMOOTHING * sensSmooth), frameDtMs);
    }
    const value = Math.max(0, Math.min(100, Math.round(this._seiEma)));
    this.seiSum += value;
    this.seiCount++;
    if (this.minSei === null || value < this.minSei) this.minSei = value;
    return value;
  }

  updateFatigue(perclosValue, avgBlinkMs, yawnsRecent, bpm, bpmReliable, drowsyNow,
    thrBlinkLow, thrBlinkHigh, sensLevel, frameDtMs) {
    let raw = clamp01((perclosValue - 3) / 17) * 35;
    if (avgBlinkMs !== null && avgBlinkMs !== undefined) {
      raw += MuscleSensitivity.blinkLoad(sensLevel, avgBlinkMs) * 20;
    }
    raw += Math.min(25, yawnsRecent * 8);
    if (bpmReliable && (bpm < thrBlinkLow || bpm > thrBlinkHigh)) raw += 10;
    if (drowsyNow) raw += 10;
    const target = Math.min(100, raw);
    this._fatigueEma += (target - this._fatigueEma) * frameAlpha(FATIGUE_SMOOTHING, frameDtMs);
    return Math.round(clamp(this._fatigueEma, 0, 100));
  }

  averageSei() {
    return this.seiCount > 0 ? Math.round(this.seiSum / this.seiCount) : null;
  }
}
