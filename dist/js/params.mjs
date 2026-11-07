// Every number that has to agree with the phone and with edge-server/focusedge lives here.
//
// The project has three implementations of one measurement: Kotlin on the phone, Python on the class
// camera, this JS build in a browser. Every drift found so far was one literal edited in one of them
// while the other two kept the old value, so a threshold is only allowed to exist once per artifact
// and each value names the line it was copied from. When the phone changes, change it here AND in
// focusedge/constants.py - never in the file that reads it.

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** clamp01 in the Kotlin app and in constants.py: a NaN score is treated as no penalty, not as 1. */
export function clamp01(v) { return Number.isNaN(v) ? 0 : clamp(v, 0, 1); }

export function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

/** Median of a copy-on-write list; constants.py uses statistics.median for the same baselines. */
export function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --- eye validity gate -----------------------------------------------------
// MainActivity.kt:288-289. 45 degrees was the value before the 2026-11-01 eye definition change;
// both other devices now stop measuring at 28, so this one must not keep measuring to 45.
export const EYE_MAX_YAW_DEG = 28;
export const EYE_MAX_PITCH_DEG = 35;

// --- blink / drowsiness ----------------------------------------------------
// MainActivity.kt:269-272, 280.
export const DROWSY_CLOSURE_MS = 1500;
export const BPM_WINDOW_MS = 60000;
export const BPM_MIN_WINDOW_MS = 10000;
export const BPM_RELIABLE_AFTER_MS = 15000;
export const LOW_BLINK_BPM = 8;
export const HIGH_BLINK_BPM = 30;
export const PERCLOS_ALERT = 15;
export const PERCLOS_P70_OPEN = 0.30;
export const PERCLOS_P80_OPEN = 0.20;

// --- gaze, head turn, drift ------------------------------------------------
// constants.py:155-161, from MainActivity.kt.
export const LOOK_AWAY_YAW_DEG = 18;
export const LOOK_AWAY_PITCH_DEG = 18;
export const LOOK_AWAY_MS = 2000;
export const HEAD_FRONTAL_YAW_DEG = 20;
export const GAZE_H_DRIFT = 0.16;
export const GAZE_V_DRIFT = 0.22;
export const VISUAL_DRIFT_MS = 3000;
// MainActivity.kt:4402 - the eye must be open before a landmark shift counts as a look away.
export const EYES_OPEN_FOR_GAZE = 0.75;

// --- micro-expression ------------------------------------------------------
// constants.py:163-170. jawOpen is the phone's SECOND yawn clause, not a replacement for MAR.
export const JAW_OPEN_YAWN = 0.55;
export const MAR_YAWN = 0.55;
export const BFR_FURROW_RATIO = 0.88;
export const BFR_SUSTAIN_MS = 2000;
export const YAWN_MIN_MS = 1200;
export const YAWN_WINDOW_MS = 5 * 60 * 1000;

// --- distance --------------------------------------------------------------
// constants.py:183, 227 and MainActivity.kt:237-241. The phone switches the warning on at 30 and off
// at 32 because a bare "< 30" flaps on an estimate that still jitters by a centimetre.
export const MIN_SAFE_DISTANCE_CM = 30;
export const DISTANCE_RECOVER_CM = 32;
export const EYE_OUTER_WIDTH_CM = 8.9;
export const REF_DISTANCE_CM = 50;
export const DEFAULT_HORIZONTAL_FOV_DEG = 60;

// --- SEI -------------------------------------------------------------------
// constants.py:145-153, 213-216.
export const SEI_SMOOTHING = 0.12;
export const FATIGUE_SMOOTHING = 0.1;
export const W_POSTURE = 0.20;
export const W_DISTANCE = 0.15;
export const W_GAZE = 0.20;
export const W_EYES = 0.20;
export const W_BPM = 0.10;
export const W_EXPRESSION = 0.15;
export const SEI_TOO_CLOSE_PENALTY = 15;
export const SEI_CHRONIC_PENALTY = 20;
export const SEI_WATCH_PENALTY = 8;
export const SEI_ANOMALY_CAP = 40;

// --- work clock and the personal floor -------------------------------------
// constants.py: BREAK_DETECT_MS is the phone's "face gone long enough to be a real break".
export const BREAK_DETECT_MS = 20000;
export const BREAK_REMINDER_MS = 20 * 60 * 1000;
export const BREAK_REMINDER_SHOW_MS = 30000;
export const LOW_VS_PERSONAL_MS = 45000;
export const LOW_VS_PERSONAL_K = 1.5;
export const PERSONAL_SEI_MIN_SPREAD = 8;

/**
 * MuscleSensitivity in focusedge/constants.py, itself FocusCore.kt's sensitivity object.
 *
 * There are FOUR tables, not one, and the phone moves them independently: time_factor stretches an
 * alert timer, sens_thr scales the angle/gaze ENTRY gate, sens_smooth changes how tightly SEI follows
 * the instant score, and factor() is the muscle threshold multiplier. factor() and sens_thr disagree
 * on purpose (0.70 vs 0.72 at level 3) - that is what the phone does, so do not "unify" them.
 */
export class MuscleSensitivity {
  static BLINK_LOAD_FLOOR_MS = 150;
  static BLINK_LOAD_RAMP_MS = 250;

  static factor(level) { return { 0: 1.15, 2: 0.85, 3: 0.70 }[level] ?? 1.0; }
  static timeFactor(level) { return { 0: 1.5, 2: 0.6, 3: 0.35 }[level] ?? 1.0; }
  static sensThr(level) { return { 0: 1.15, 2: 0.85, 3: 0.72 }[level] ?? 1.0; }
  static sensSmooth(level) { return { 0: 0.7, 2: 1.6, 3: 2.4 }[level] ?? 1.0; }

  static mouthThreshold(level, base) { return base * MuscleSensitivity.factor(level); }

  /** furrowRatio() in FocusCore.kt:481. The base is a ceiling, so a higher level RAISES it: 0.88 -> 0.90. */
  static furrowRatio(level, base) { return 1 - (1 - base) * MuscleSensitivity.factor(level); }

  /** furrowYawWindow() in FocusCore.kt:487: an acceptance window, so it takes the inverse. */
  static furrowYawWindow(level, baseDeg) { return baseDeg / MuscleSensitivity.factor(level); }

  static blinkLoad(level, avgBlinkMs) {
    const lo = MuscleSensitivity.BLINK_LOAD_FLOOR_MS * MuscleSensitivity.factor(level);
    const ramp = MuscleSensitivity.BLINK_LOAD_RAMP_MS * MuscleSensitivity.factor(level);
    return clamp((avgBlinkMs - lo) / ramp, 0, 1);
  }
}

// Landmark indices the browser build still needs for the two ratios the phone learns a band for.
// constants.py:130-135 / MainActivity.kt:4182-4190.
export const LM_BROW_INNER_R = 55;
export const LM_BROW_INNER_L = 285;
export const LM_MOUTH_UP = 13;
export const LM_MOUTH_LOW = 14;
export const LM_MOUTH_R = 78;
export const LM_MOUTH_L = 308;
export const LM_NOSE_TIP = 1;
export const LM_COUNT = 478;
