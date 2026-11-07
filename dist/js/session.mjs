// The per-frame pipeline around EyeEngine, ported from MainActivity.kt through
// edge-server/focusedge/person_pipeline.py.
// Kept separate from the browser on purpose: it takes landmarks, blendshapes, a timestamp and the
// light measurements, and returns numbers - so it can run under node in _dev/ and be compared against
// the phone's own output frame by frame, and against the Python implementation on the same input.
//
// The order of the steps is the phone's order, because the steps are not independent: the pose
// deviation feeds the eye compensation, the eye validity feeds the PERCLOS windows, the calibration
// baseline is frozen from whatever was accepted before monitoring started, and the SEI reads the
// distance alert and the look-away timer that were decided several steps earlier.

import { OneEuroFilter, WindowRatio, RATIO_CAP_FRAME_MS, RATIO_REF_FRAME_MS } from './core.mjs';
import { EyeEngine, extractBlend } from './eye.mjs';
import {
  LEFT_EYE,
  LM_NOSE_TIP,
  LM_OUTER_LEFT_EYE,
  LM_OUTER_RIGHT_EYE,
  RIGHT_EYE,
  browFurrowRatio,
  calculateEar,
  computeHeadPose,
  computeSignalQuality,
  estimateDistanceCm,
  focalPx,
  mouthAspectRatio,
  pixelDistance,
  rawGaze,
} from './measure.mjs';
import {
  BFR_FURROW_RATIO,
  BFR_SUSTAIN_MS,
  BPM_WINDOW_MS,
  BREAK_DETECT_MS,
  BREAK_REMINDER_MS,
  BREAK_REMINDER_SHOW_MS,
  DROWSY_CLOSURE_MS,
  DISTANCE_RECOVER_CM,
  EYE_MAX_PITCH_DEG,
  EYE_MAX_YAW_DEG,
  EYES_OPEN_FOR_GAZE,
  GAZE_H_DRIFT,
  GAZE_V_DRIFT,
  HEAD_FRONTAL_YAW_DEG,
  HIGH_BLINK_BPM,
  JAW_OPEN_YAWN,
  LOOK_AWAY_MS,
  LOOK_AWAY_PITCH_DEG,
  LOOK_AWAY_YAW_DEG,
  LOW_BLINK_BPM,
  LOW_VS_PERSONAL_MS,
  LOW_VS_PERSONAL_K,
  MAR_YAWN,
  MIN_SAFE_DISTANCE_CM,
  MuscleSensitivity,
  PERCLOS_ALERT,
  REF_DISTANCE_CM,
  VISUAL_DRIFT_MS,
  YAWN_MIN_MS,
  YAWN_WINDOW_MS,
  clamp,
  isFiniteNumber,
  median,
} from './params.mjs';
import { SeiTracker, bpmScore, distanceScore, expressionScore, eyeScore, gazeScore, headScore } from './sei.mjs';
import { SituationFrame, SituationEngine } from './situation.mjs';
import { phoneContextPenalty } from './detect.mjs';
import { pickAlert } from './alerts.mjs';
import {
  HF, HF_BAND_FEATURES, HabitSession, earBlendFactor, historyText, personalThresholds,
} from './habit.mjs';

// MainActivity.kt:249-255 - the calibration phase.
export const CALIBRATION_FRAMES = 60;
export const CALIBRATION_MIN_EAR = 0.20;
export const CAL_RELAX_AFTER_MS = 6000;
export const CAL_RELAX_MIN_FRAMES = 10;
export const CAL_RELAXED_MIN_EAR = 0.12;
export const CLOSE_RATIO = 0.68;

// MainActivity.kt:122 - how often the learned sentences are rebuilt. The habit block is four long
// strings, and the phone deliberately does not recompute them per frame.
export const HABIT_STATUS_REFRESH_MS = 1000;

// MainActivity.kt:121 - how often the run in progress is written into the profile without ending it.
// A sitting that is only saved when somebody presses stop loses everything if the tab is closed.
export const HABIT_AUTOSAVE_MS = 30000;

// MainActivity.kt:258-261 - blink rate window and the "eyes shut too long" floor.
export const BPM_MIN_WINDOW_MS = 10000;
export const BPM_RELIABLE_AFTER_MS = 15000;

// MainActivity.kt:270-276 - PERCLOS P70 / P80 open-eye ceilings.
export const PERCLOS_P70_OPEN = 0.30;
export const PERCLOS_P80_OPEN = 0.20;

export class MonitorSession {
  constructor() {
    this.engine = new EyeEngine();
    this.yawFilter = new OneEuroFilter(1.5, 0.30);
    this.pitchFilter = new OneEuroFilter(1.5, 0.30);
    this.rollFilter = new OneEuroFilter(1.5, 0.30);
    this.gazeHFilter = new OneEuroFilter(1.5, 5.0);
    this.gazeVFilter = new OneEuroFilter(1.5, 5.0);
    this.distFilter = new OneEuroFilter(1.5, 1.0);

    // MainActivity.kt:834-840 - the three PERCLOS windows pass the 33 ms reference cadence explicitly.
    this.perclos = new WindowRatio(60, 3000, RATIO_CAP_FRAME_MS, RATIO_REF_FRAME_MS);
    this.perclosP70 = new WindowRatio(60, 3000, RATIO_CAP_FRAME_MS, RATIO_REF_FRAME_MS);
    this.perclosP80 = new WindowRatio(60, 3000, RATIO_CAP_FRAME_MS, RATIO_REF_FRAME_MS);

    this.situation = new SituationEngine();
    this.sei = new SeiTracker();

    this.sensLevel = 1;
    this.frameWidth = 640;
    this.frameHeight = 480;

    // The phone personalises eight thresholds once a student has five sessions of history. These are
    // fields, not constants, so a profile can be applied without touching a single comparison - and
    // applyProfile() below is what does it. With no profile bound (no name typed in the page) every one
    // of them stays at the base constant, which is exactly what the phone uses for a first-time
    // student and what the class camera uses until a roster entry has data.
    this.baseThresholds = {
      lookYaw: LOOK_AWAY_YAW_DEG,
      lookPitch: LOOK_AWAY_PITCH_DEG,
      gazeH: GAZE_H_DRIFT,
      gazeV: GAZE_V_DRIFT,
      blinkLow: LOW_BLINK_BPM,
      blinkHigh: HIGH_BLINK_BPM,
      perclos: PERCLOS_ALERT,
      mar: MAR_YAWN,
    };
    this.thrGazeH = GAZE_H_DRIFT;
    this.thrGazeV = GAZE_V_DRIFT;
    this.thrBlinkLow = LOW_BLINK_BPM;
    this.thrBlinkHigh = HIGH_BLINK_BPM;
    this.thrPerclos = PERCLOS_ALERT;
    this.thrMar = MAR_YAWN;
    this.thrLookYaw = LOOK_AWAY_YAW_DEG;
    this.thrLookPitch = LOOK_AWAY_PITCH_DEG;
    this.personalSeiMean = null;
    this.personalSeiSpread = null;

    // The learned half: a HabitProfile loaded from this browser's localStorage, and the run being
    // accumulated right now. Both null until somebody types a name into the page - the phone refuses
    // to learn about a student it has no profile for (beginHabitSession, MainActivity.kt:2548), and
    // inventing an anonymous profile would be a profile of nobody.
    this.profile = null;
    this.habitSession = null;
    this.personalCount = 0;
    this.personalBlend = 0;
    // The learned numbers the HUD quotes, frozen with the bands when this run's session opened. Recomputed
    // per frame would cost a 12-feature pass over up to 40 sessions every 30 ms for a line that is
    // deliberately not allowed to move mid-session.
    this.habitBaseline = null;
    // The four lines the column reads, rebuilt on the phone's one-second tick rather than per frame.
    // historyText walks every stored session and baseline() sorts them: work done 30 times a second for
    // a sentence that must not visibly move between two frames of the same run.
    this.habitFactsCache = null;
    this.habitFactsAtMs = -1;

    this.reset();
  }

  setSensitivity(level) {
    this.sensLevel = level;
    this.engine.setSensitivity(level);
    if (this.habitSession) this.habitSession.sensitivityLevel = level;
  }

  /**
   * Bind this run to one student's learned profile, or unbind it with null.
   *
   * Called at page load from localStorage and again whenever the operator changes the name. The
   * thresholds move immediately (the phone re-applies them at every beginHabitSession, and a name
   * typed mid-run is the same event); the run already accumulating is committed to the OLD profile
   * before the swap, so its frames are never attributed to the next student - which is the whole reason
   * the phone keeps a binding lock (MainActivity.kt:2404-2412).
   *
   * Returns the profile that was bound before this call, or null. The caller stores it: a profile is
   * only as good as the browser write behind it, and this file does not touch localStorage.
   */
  setProfile(profile) {
    if (this.profile === profile) return null;
    const previous = this.profile;
    this.endHabitSession();
    this.profile = profile || null;
    this.resetPersonalParams();
    if (this.profile && this.calibrated) this.applyProfile();
    this.habitFactsCache = null;
    return previous;
  }

  /** resetPersonalParams, MainActivity.kt:2440-2462 - the un-learned state is the base constants. */
  resetPersonalParams() {
    const b = this.baseThresholds;
    this.thrLookYaw = b.lookYaw;
    this.thrLookPitch = b.lookPitch;
    this.thrGazeH = b.gazeH;
    this.thrGazeV = b.gazeV;
    this.thrBlinkLow = b.blinkLow;
    this.thrBlinkHigh = b.blinkHigh;
    this.thrPerclos = b.perclos;
    this.thrMar = b.mar;
    this.personalSeiMean = null;
    this.personalSeiSpread = null;
    this.personalCount = 0;
    this.personalBlend = 0;
    this.habitBaseline = null;
  }

  /**
   * applyPersonalParams (MainActivity.kt:2465) for the profile this run is bound to. Returns nothing:
   * its whole output is the eight fields the comparisons below already read.
   *
   * It is a no-op while the profile is not ready, so the first four sessions of a student are measured
   * with the plain constants - which is the phone's behaviour, not a limitation of this port.
   */
  applyProfile() {
    const p = personalThresholds(this.profile, this.baseThresholds);
    this.habitBaseline = p.blend > 0 ? this.profile.baseline() : null;
    this.thrLookYaw = p.lookYaw;
    this.thrLookPitch = p.lookPitch;
    this.thrGazeH = p.gazeH;
    this.thrGazeV = p.gazeV;
    this.thrBlinkLow = p.blinkLow;
    this.thrBlinkHigh = p.blinkHigh;
    this.thrPerclos = p.perclos;
    this.thrMar = p.mar;
    this.personalSeiMean = p.personalSeiMean;
    this.personalSeiSpread = p.personalSeiSpread;
    this.personalCount = p.count;
    this.personalBlend = p.blend;
    return p;
  }

  /**
   * beginHabitSession, MainActivity.kt:2541-2578, called from finishCalibration.
   *
   * The id is the wall clock of the start - the phone's rule and the class camera's (classroom.py:349).
   * A per-page counter restarted at 1 on every reload, so a second run of the same student wrote the
   * same key twice and the second run replaced the first one's stored session.
   *
   * Returns the factor the calibration EAR baselines must be blended by (1 when there is nothing to
   * blend): the phone multiplies its own baselineEar1/2 inside blendEarWithHabit and then hands
   * earAfter/earBefore to the eye engine (MainActivity.kt:3596-3600), so the caller applies it the same
   * way instead of inventing a second blending path here.
   */
  startHabitSession() {
    this.habitFactsCache = null;
    if (!this.profile) {
      this.habitSession = null;
      return 1;
    }
    const s = new HabitSession(Date.now());
    s.sensitivityLevel = this.sensLevel;
    this.habitSession = s;
    // Recorded BEFORE any blending, so a learned EAR cannot amplify itself across sessions.
    if (this.baselineEar1 !== null && this.baselineEar2 !== null) {
      s.observe(HF.EAR, (this.baselineEar1 + this.baselineEar2) / 2);
    }
    if (!this.profile.isReady()) return 1;
    this.applyProfile();
    s.setBands(this.habitBaseline, HF_BAND_FEATURES);
    return earBlendFactor(this.profile, this.baselineEar1, this.baselineEar2);
  }

  /**
   * commitHabitSession, MainActivity.kt:2633-2640 - the accumulator is NOT closed.
   *
   * commit() replaces the stored record with the same session id, so saving twice during one run
   * updates that entry instead of duplicating it, and a run that crosses the five-session bar starts
   * using its own thresholds before anybody presses stop. The return says whether the profile changed
   * and why the session was refused, so the page can persist only what moved and log a refusal in the
   * phone's own words rather than dropping the run silently.
   */
  saveHabitSession() {
    const p = this.profile;
    const s = this.habitSession;
    this.habitFactsCache = null;
    if (!p || !s) return null;
    const summary = s.toSummary();
    const reason = p.ineligibleReason(summary);
    return { changed: p.commit(summary), reason, summary };
  }

  /**
   * endHabitSession, MainActivity.kt:2642-2653 - commit, then close.
   *
   * Used when the sitting is over: the operator pressed Dừng, asked for a new calibration, or the tab is
   * going away - and from setProfile, which commits under the OLD identity before swapping. The commit
   * comes first because the summary belongs to the profile that was bound while these frames were
   * measured. The phone also uploads the record to Firestore here; this leg has no network path, so the
   * caller stores the profile locally and the run ends at the browser boundary. commit() keys the record
   * by session id, so this is the same write the 30-second autosave has been repeating and it cannot
   * double-count the run. The returned verdict says whether the profile moved and, if it did not, the
   * phone's own sentence for why the run was refused.
   */
  endHabitSession() {
    const out = this.saveHabitSession();
    this.habitSession = null;
    this.habitFactsCache = null;
    return out;
  }

  /**
   * Close the run WITHOUT committing it. The phone has no such path - deleting a profile means wiping the
   * app's storage, not pressing a button mid-sitting - so the page needs one place to say "throw these
   * frames away" instead of reaching into habitSession from outside.
   */
  discardHabitSession() {
    this.habitSession = null;
    this.habitFactsCache = null;
  }

  /**
   * What the learned profile says about this run, for the HUD's habit block.
   *
   * Null when nobody is bound: the column must not print a profile of nobody, and the sentence it
   * falls back to is the one hud.py prints for an empty roster.
   */
  habitSnapshot() {
    const p = this.profile;
    if (!p) return null;
    const base = this.habitBaseline;
    return {
      id: p.id,
      name: p.name,
      sessions: p.sessionCount(),
      totalMin: p.totalValidMs() / 60000,
      ready: p.isReady(),
      confidence: p.confidence(),
      personalCount: this.personalCount,
      blend: this.personalBlend,
      hasSession: this.habitSession !== null,
      currentValidMs: this.habitSession ? this.habitSession.validMs : 0,
      meanBpm: base ? base.mean(HF.BPM) : null,
      meanDist: base ? base.mean(HF.DIST) : null,
      meanSei: base ? base.mean(HF.SEI) : null,
      bandFeatures: base ? HF_BAND_FEATURES.filter((f) => base.band(f) !== null).length : 0,
    };
  }

  /**
   * The live session's band verdicts - refreshBandText's inputs (MainActivity.kt:2860-2901).
   *
   * Null while no session is accumulating, which is the phone's "chưa có phiên nào đang đo" case. The
   * caller refreshes this about once a second, the way the phone does on its 1-second tick, because
   * the counts only ever feed a sentence.
   */
  habitBandFacts() {
    const s = this.habitSession;
    if (!s) return null;
    const outcomes = s.bandOutcomes();
    let samples = 0;
    let below = 0;
    let above = 0;
    for (const o of outcomes) {
      samples += o.samples;
      below += o.below;
      above += o.above;
    }
    return {
      covered: s.bandCoverage(HF_BAND_FEATURES),
      total: HF_BAND_FEATURES.length,
      samples,
      below,
      above,
      noBands: outcomes.length === 0,
    };
  }

  /**
   * The learned sentences, on the phone's one-second tick (MainActivity.kt:2763-2768 calls
   * buildHabitStatus, historyText and refreshBandText together and the frame only reads the result).
   *
   * The web loop runs 30 times a second and historyText sorts every stored session, so recomputing it
   * per frame would be the one place in this port where a description costs measurement time. The
   * cache is dropped whenever the identity or the run changes, so the line still moves the moment an
   * operator types a new name or a session is committed - it just does not flicker while nothing changed.
   */
  habitFacts(nowMs) {
    if (this.habitFactsCache === null || nowMs - this.habitFactsAtMs >= HABIT_STATUS_REFRESH_MS) {
      this.habitFactsAtMs = nowMs;
      const p = this.profile;
      this.habitFactsCache = {
        studentName: p ? p.name : null,
        habit: this.habitSnapshot(),
        band: this.habitBandFacts(),
        history: p ? historyText(p, 5) : '',
      };
    }
    return this.habitFactsCache;
  }

  /**
   * _observe_session in person_pipeline.py:867-906 - same guard, same twelve features, same order.
   *
   * A frame the eye engine did not trust, or one with no SEI, is not a frame worth learning from; and
   * the PERCLOS that gets learned is perclosForScore, the value the score was built from, not the one
   * printed when the window has not filled yet.
   */
  observeHabit(nowMs, eye, bpm, bpmReliable, dist, yawDev, pitchDev, gazeHDev, gazeVDev,
    mar, bfr, perclosForScore, seiVal, quality) {
    const hs = this.habitSession;
    const feats = {};
    if (!hs) return feats;
    const valid = eye.valid && !eye.closed && seiVal !== null && seiVal !== undefined;
    hs.tick(nowMs, true, valid);
    if (!valid) return feats;
    if (quality !== null && quality !== undefined) hs.addQuality(quality);
    if (bpmReliable) {
      hs.observe(HF.BPM, bpm);
      feats[HF.BPM] = bpm;
    }
    if (this.blinkDurations.length) {
      const avg = this.blinkDurations.reduce((a, b) => a + b, 0) / this.blinkDurations.length;
      hs.observe(HF.BLINK_MS, avg);
      feats[HF.BLINK_MS] = avg;
    }
    if (dist !== null && dist !== undefined) {
      hs.observe(HF.DIST, dist);
      feats[HF.DIST] = dist;
    }
    const put = (f, v) => { hs.observe(f, v); feats[f] = v; };
    put(HF.YAW, yawDev);
    put(HF.PITCH, pitchDev);
    put(HF.GAZE_H, gazeHDev);
    put(HF.GAZE_V, gazeVDev);
    put(HF.MAR, mar);
    put(HF.BFR, bfr);
    put(HF.EAR, eye.openness);
    put(HF.PERCLOS, perclosForScore);
    put(HF.SEI, seiVal);
    for (const f of HF_BAND_FEATURES) {
      if (feats[f] !== undefined) hs.observeBand(f, feats[f]);
    }
    return feats;
  }

  get sensTime() { return MuscleSensitivity.timeFactor(this.sensLevel); }

  get sensThr() { return MuscleSensitivity.sensThr(this.sensLevel); }

  get sensSmooth() { return MuscleSensitivity.sensSmooth(this.sensLevel); }

  /**
   * Pixel size the normalized landmarks are converted with - the phone passes the bitmap it fed to
   * MediaPipe. Every ratio here is aspect-dependent, so a frame resize must reset the session: the
   * learned baselines were measured in the old pixel scale.
   */
  setFrameSize(width, height) {
    const changed = this.frameWidth !== width || this.frameHeight !== height;
    this.frameWidth = width;
    this.frameHeight = height;
    if (changed && this.calibrated) this.reset();
  }

  reset() {
    // The accumulator dies with the run. The caller commits it first if the sitting is worth keeping;
    // leaving it alive here would merge two separate sittings into one session, which is the bug
    // classroom.py:349 records for the class camera.
    this.habitSession = null;
    this.calibrated = false;
    this.calWaitStartMs = 0;
    this.calFrames = 0;
    this.calRejected = 0;
    this.calSumEar1 = 0;
    this.calSumEar2 = 0;
    this.calSumYaw = 0;
    this.calSumPitch = 0;
    this.calSumGazeH = 0;
    this.calSumGazeV = 0;
    this.calYaw = [];
    this.calPitch = [];
    this.calGazeH = [];
    this.calGazeV = [];
    this.calBfr = [];
    this.calDistRaw = [];
    this.baselineYaw = 0;
    this.baselinePitch = 0;
    this.baselineGazeH = 0.5;
    this.baselineGazeV = 0.5;
    this.baselineEar1 = null;
    this.baselineEar2 = null;
    this.baselineBfr = 0.2;
    this.closeThreshold1 = null;
    this.closeThreshold2 = null;

    this.poseYawAbs = 0;
    this.posePitchAbs = 0;
    this.poseRollAbs = 0;
    this.eyesClosed = false;
    this.closedStartMs = 0;
    this.blinkTimestamps = [];
    this.blinkDurations = [];
    this.blinkTotal = 0;
    this.monitoringStartMs = 0;
    this.lastSignal = null;

    // Distance is measured in centimetres only after this session has a ruler. 1.0 means "not
    // calibrated", and the HUD says so instead of presenting the raw estimate as a centimetre value.
    this.distanceScale = 1.0;
    this.distanceCalibrated = false;
    this.distanceCm = null;
    this.distanceAlertActive = false;

    this.poseWindow = [];
    this.prevNose = [NaN, NaN];
    this.jitterEma = 0;
    this.lookAwayStartMs = 0;
    this.driftStartMs = 0;
    this.furrowStartMs = 0;
    this.yawnStartMs = 0;
    this.yawnCounted = false;
    this.yawnTimestamps = [];
    this.lowVsPersonalStartMs = 0;
    this.workStartMs = 0;
    this.faceLostSinceMs = 0;
    this.lastNowMs = 0;
    this.landmarkCount = 0;

    this.engine.reset();
    this.resetFilters();
    this.perclos.reset();
    this.perclosP70.reset();
    this.perclosP80.reset();
    this.situation.reset();
    this.sei.reset();
  }

  resetFilters() {
    this.yawFilter.reset();
    this.pitchFilter.reset();
    this.rollFilter.reset();
    this.gazeHFilter.reset();
    this.gazeVFilter.reset();
    this.distFilter.reset();
  }

  /**
   * Face lost or stream restarted: wipes the instant state, keeps the calibration. The caller passes
   * the same clock it feeds process(), because "the face is gone" is only a break after 20 seconds of
   * gone, and measuring that needs to know when the last absence started.
   */
  pause(nowMs = this.lastNowMs) {
    this.engine.pause();
    this.perclos.pause();
    this.perclosP70.pause();
    this.perclosP80.pause();
    this.distFilter.reset();
    this.prevNose = [NaN, NaN];
    this.eyesClosed = false;
    this.closedStartMs = 0;
    this.lookAwayStartMs = 0;
    this.driftStartMs = 0;
    this.furrowStartMs = 0;
    this.yawnStartMs = 0;
    this.yawnCounted = false;
    this.distanceAlertActive = false;
    this.distanceCm = null;
    // MainActivity.kt:3901-3907: before the 20 seconds elapse the work clock keeps running through
    // the gap, so a student who briefly looks down does not get a free 20 more minutes.
    if (this.faceLostSinceMs === 0) this.faceLostSinceMs = nowMs;
    if (this.calibrated && nowMs - this.faceLostSinceMs >= BREAK_DETECT_MS) this.workStartMs = 0;
  }

  /**
   * MainActivity.kt:3793-4004 - everything measured from the landmarks before the eyes are judged.
   * `light` is {lumaMean, backlit, overexposed} from the page; null means the page could not read it,
   * which is treated as "no penalty from lighting" and is reported in the result so the HUD can say
   * the number is not the same kind of number the phone prints.
   */
  measure(pts, nowMs, light) {
    const w = this.frameWidth;
    const h = this.frameHeight;
    const ear1 = calculateEar(pts, RIGHT_EYE, w, h);
    const ear2 = calculateEar(pts, LEFT_EYE, w, h);

    const pose = computeHeadPose(pts, w, h);
    if (pose) {
      this.poseYawAbs = pose.yawAbs;
      this.posePitchAbs = pose.pitchAbs;
      this.poseRollAbs = pose.rollAbs;
    }

    // The deviation is always against the frozen baseline; before calibration that baseline is 0,
    // which is why the quality score below deliberately ignores pose while uncalibrated.
    const yawDeg = this.yawFilter.filter(this.poseYawAbs - this.baselineYaw, nowMs);
    const pitchDeg = this.pitchFilter.filter(this.posePitchAbs - this.baselinePitch, nowMs);
    const rollDeg = this.rollFilter.filter(this.poseRollAbs, nowMs);

    const faceWidthPx = pixelDistance(pts, LM_OUTER_RIGHT_EYE, LM_OUTER_LEFT_EYE, w, h);
    const gaze = rawGaze(pts, w, h);
    const gazeH = this.gazeHFilter.filter(gaze.h, nowMs);
    const gazeV = this.gazeVFilter.filter(gaze.v, nowMs);

    const quality = computeSignalQuality(
      light ? light.lumaMean : 128,
      faceWidthPx,
      this.calibrated ? Math.abs(yawDeg) : 0,
      this.calibrated ? Math.abs(pitchDeg) : 0,
      gaze.irisOk,
      light ? light.backlit : false,
      light ? light.overexposed : false,
    );

    return {
      ear1,
      ear2,
      faceWidthPx,
      gazeH,
      gazeV,
      irisAvailable: gaze.irisOk,
      yawDeg,
      pitchDeg,
      rollDeg,
      quality: quality.quality,
      reliable: quality.reliable,
      qualityNote: quality.note,
      lightOk: light !== null,
    };
  }

  /** MainActivity.kt:4021-4067 - collect 60 clean frames, then freeze the personal baselines. */
  calibrate(m, pts, blend, nowMs) {
    if (this.calWaitStartMs === 0) this.calWaitStartMs = nowMs;

    const relaxed = this.calFrames < CAL_RELAX_MIN_FRAMES &&
      nowMs - this.calWaitStartMs >= CAL_RELAX_AFTER_MS;
    const minEar = relaxed ? CAL_RELAXED_MIN_EAR : CALIBRATION_MIN_EAR;

    // The head must stay near the frames already accepted, otherwise a student turning away during
    // calibration drags the pose and gaze baseline with it.
    const poseStable = this.calFrames < 8 ||
      (Math.abs(this.poseYawAbs - this.calSumYaw / this.calFrames) < 10 &&
        Math.abs(this.posePitchAbs - this.calSumPitch / this.calFrames) < 10);

    if (m.reliable && m.ear1 > minEar && m.ear2 > minEar && poseStable) {
      this.calRejected = 0;
      this.calSumEar1 += m.ear1;
      this.calSumEar2 += m.ear2;
      this.calSumYaw += this.poseYawAbs;
      this.calSumPitch += this.posePitchAbs;
      this.calSumGazeH += m.gazeH;
      this.calSumGazeV += m.gazeV;
      this.calYaw.push(this.poseYawAbs);
      this.calPitch.push(this.posePitchAbs);
      if (m.irisAvailable) {
        this.calGazeH.push(m.gazeH);
        this.calGazeV.push(m.gazeV);
      }
      const bfr = browFurrowRatio(pts, this.frameWidth, this.frameHeight);
      if (bfr !== null) this.calBfr.push(bfr);
      const rawDist = estimateDistanceCm(pts, this.frameWidth, this.frameHeight,
        focalPx(this.frameWidth), Math.abs(this.poseYawAbs));
      if (rawDist !== null) this.calDistRaw.push(rawDist);
      this.engine.addCalibrationSample(pts, this.frameWidth, this.frameHeight, blend);
      this.calFrames++;
      if (this.calFrames >= CALIBRATION_FRAMES) {
        this.finishCalibration(nowMs);
      }
    } else if (m.reliable) {
      this.calRejected++;
      if (this.calRejected > 90) {
        this.calRejected = 0;
        this.calFrames = 0;
        this.calSumEar1 = 0;
        this.calSumEar2 = 0;
        this.calSumYaw = 0;
        this.calSumPitch = 0;
        this.calSumGazeH = 0;
        this.calSumGazeV = 0;
        this.calYaw = [];
        this.calPitch = [];
        this.calGazeH = [];
        this.calGazeV = [];
        this.calBfr = [];
        this.calDistRaw = [];
        this.engine.reset();
      }
    }
    return { calibrated: this.calibrated, frames: this.calFrames, target: CALIBRATION_FRAMES };
  }

  /**
   * MainActivity.kt:3374-3400 and :3591-3612 - collect 60 clean frames, then freeze the baselines.
   *
   * The distance ruler is still the one place this build cannot match the phone: the phone stores a
   * factor measured against a real reference for this student, and the class camera reads the same
   * factor from its roster. A browser page has neither, so it takes the median raw estimate collected
   * during calibration and calls that REF_DISTANCE_CM. That is an ASSUMPTION about where the visitor was
   * sitting, and the HUD prints the factor next to the distance so nobody reads it as measured.
   *
   * A stored profile's own distanceScale is deliberately NOT read here: it was calibrated against the
   * phone's camera at a different focal length, and applying it to this webcam would print a centimetre
   * figure measured by a different instrument.
   */
  finishCalibration(nowMs) {
    const n = this.calFrames;
    this.baselineEar1 = this.calSumEar1 / n;
    this.baselineEar2 = this.calSumEar2 / n;

    // The phone's order (MainActivity.kt:3596-3602): open the habit session on the RAW base EAR, let it
    // blend the two baselines, then hand the eye engine the ratio between before and after. Without a
    // profile that ratio is exactly 1, which is what this line did before the profile existed.
    const earBefore = (this.baselineEar1 + this.baselineEar2) / 2;
    const blend = this.startHabitSession();
    this.baselineEar1 *= blend;
    this.baselineEar2 *= blend;
    const earAfter = (this.baselineEar1 + this.baselineEar2) / 2;
    this.engine.finishCalibration(earBefore > 0 ? earAfter / earBefore : 1);
    this.closeThreshold1 = this.baselineEar1 * CLOSE_RATIO;
    this.closeThreshold2 = this.baselineEar2 * CLOSE_RATIO;
    this.baselineYaw = median(this.calYaw.length ? this.calYaw : [this.calSumYaw / n]);
    this.baselinePitch = median(this.calPitch.length ? this.calPitch : [this.calSumPitch / n]);
    this.baselineGazeH = median(this.calGazeH) ?? 0.5;
    this.baselineGazeV = median(this.calGazeV) ?? 0.5;
    this.baselineBfr = median(this.calBfr) ?? 0.2;
    const rawMedian = median(this.calDistRaw);
    if (rawMedian && rawMedian > 0) {
      this.distanceScale = REF_DISTANCE_CM / rawMedian;
      this.distanceCalibrated = true;
    }

    this.calibrated = true;
    this.monitoringStartMs = nowMs;
    this.workStartMs = nowMs;
    this.faceLostSinceMs = 0;
    this.blinkTimestamps = [];
    this.blinkDurations = [];
    this.eyesClosed = false;
    this.resetFilters();
    this.perclos.reset();
    this.perclosP70.reset();
    this.perclosP80.reset();
    this.engine.setSensitivity(this.sensLevel);
  }

  /** constants.py PersonPipeline._pose_std_deg: population std of the turn magnitude over 10 s. */
  updatePoseWindow(nowMs, yaw, pitch, roll) {
    this.poseWindow.push([nowMs, yaw, pitch]);
    while (this.poseWindow.length && nowMs - this.poseWindow[0][0] > 10000) this.poseWindow.shift();
  }

  poseStdDeg() {
    if (this.poseWindow.length < 10) return NaN;
    const mags = this.poseWindow.map((p) => Math.hypot(p[1], p[2]));
    const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
    const varPop = mags.reduce((a, b) => a + (b - mean) * (b - mean), 0) / mags.length;
    return Math.sqrt(varPop);
  }

  /** constants.py _jitter: how far the nose tip moved since the last frame, as a fraction of width. */
  jitter(pts) {
    const nx = pts[LM_NOSE_TIP].x * this.frameWidth;
    const ny = pts[LM_NOSE_TIP].y * this.frameHeight;
    if (!Number.isNaN(this.prevNose[0])) {
      const step = Math.hypot(nx - this.prevNose[0], ny - this.prevNose[1]);
      this.jitterEma = this.jitterEma * 0.8 + step * 0.2;
    }
    this.prevNose = [nx, ny];
    return this.jitterEma / Math.max(1, this.frameWidth);
  }

  /**
   * constants.py _bfr / _mar. Both are the phone's own ratios, not a stand-in that "moves the same
   * way": BFR is the inner-brow gap over the eye-corner span (the phone learns a band for THAT
   * quantity), MAR is lip-to-lip over mouth width with a sub-pixel guard.
   */
  bfr(pts) {
    return browFurrowRatio(pts, this.frameWidth, this.frameHeight) ?? this.baselineBfr;
  }

  mar(pts) {
    return mouthAspectRatio(pts, this.frameWidth, this.frameHeight);
  }

  /**
   * constants.py _update_distance_alert: 30 cm switches the warning on, 32 cm switches it off. A bare
   * "< 30" on an estimate that jitters by a centimetre flaps the line at a desk sitting exactly there,
   * and each flap is one more counted violation than the student actually earned.
   */
  updateDistanceAlert(dist) {
    if (dist !== null && isFiniteNumber(dist)) {
      this.distanceAlertActive = dist < (this.distanceAlertActive ? DISTANCE_RECOVER_CM : MIN_SAFE_DISTANCE_CM);
    } else {
      this.distanceAlertActive = false;
    }
    return this.distanceAlertActive;
  }

  /**
   * constants.py _update_micro_expressions: frown and yawn as DURATIONS. One noisy blendshape reading
   * must not cost the full 60-point mouth penalty and fire a YAWN, and a real two-second yawn must not
   * count as thirty events in the five-minute recency window.
   * @returns {{yawnConfirmed:boolean, confused:boolean, yawnsRecent:number, furrowNow:boolean}}
   */
  updateMicroExpressions(marValue, bs, bfrValue, yawDev, nowMs) {
    const furrowTrigger = MuscleSensitivity.furrowRatio(this.sensLevel, BFR_FURROW_RATIO);
    const furrowWindow = MuscleSensitivity.furrowYawWindow(this.sensLevel, HEAD_FRONTAL_YAW_DEG);
    // The window is a frontal-face gate: brow geometry reads as lowered when the head is tipped, so a
    // furrow is only counted while the face still points at the camera.
    const furrowNow = Math.abs(yawDev) < furrowWindow && bfrValue < this.baselineBfr * furrowTrigger;
    if (furrowNow) {
      if (this.furrowStartMs === 0) this.furrowStartMs = nowMs;
    } else {
      this.furrowStartMs = 0;
    }
    const confused = this.furrowStartMs !== 0 &&
      nowMs - this.furrowStartMs >= BFR_SUSTAIN_MS * this.sensTime;

    const marThr = MuscleSensitivity.mouthThreshold(this.sensLevel, this.thrMar);
    const jawThr = MuscleSensitivity.mouthThreshold(this.sensLevel, JAW_OPEN_YAWN);
    // MainActivity.kt:4469-4472: jawOpen is read only when the blendshape list actually reaches index
    // 4, and it is the SECOND yawn clause, not a replacement for MAR.
    const jawOpen = bs && bs.length > 4 ? bs[4] : 0;
    const yawnNow = marValue > marThr || jawOpen > jawThr;
    if (yawnNow) {
      if (this.yawnStartMs === 0) {
        this.yawnStartMs = nowMs;
        this.yawnCounted = false;
      }
    } else {
      this.yawnStartMs = 0;
      this.yawnCounted = false;
    }
    const yawnConfirmed = yawnNow && nowMs - this.yawnStartMs >= YAWN_MIN_MS * this.sensTime;
    if (yawnConfirmed && !this.yawnCounted) {
      this.yawnCounted = true;
      this.yawnTimestamps.push(nowMs);
    }
    while (this.yawnTimestamps.length && nowMs - this.yawnTimestamps[0] > YAWN_WINDOW_MS) {
      this.yawnTimestamps.shift();
    }
    return { yawnConfirmed, confused, yawnsRecent: this.yawnTimestamps.length, furrowNow };
  }

  /**
   * One monitored frame -> the numbers the HUD shows. Null fields mean "not measured", never 0.
   *
   * @param {object} [nearby] the context objects the layer-1 detector put on THIS student
   *   (detect.mjs's .nearby map: name -> best confidence). Optional because it is an instrument,
   *   not a setting: the phone has no object detector at all, and this leg has none until YOLO11n
   *   answers its first pass - or while the operator holds the boxes off with key Y. With nothing
   *   passed, the scene term is 0 and every other number is exactly what it was before the term
   *   existed, which is what makes "no detector" and "detector says nothing" the same honest answer.
   */
  process(pts, result, nowMs, light, nearby) {
    const blend = extractBlend(result);
    const m = this.measure(pts, nowMs, light);
    this.landmarkCount = pts.length;
    const frameDtMs = this.lastNowMs === 0 ? 33.3 : clamp(nowMs - this.lastNowMs, 1, 3000);
    this.lastNowMs = nowMs;
    this.updatePoseWindow(nowMs, m.yawDeg, m.pitchDeg, m.rollDeg);

    if (!this.calibrated) {
      const c = this.calibrate(m, pts, blend, nowMs);
      return {
        ...m,
        calibrated: false,
        calibration: c,
        eye: null,
        baselineEar: this.engine.baselineEar(),
        landmarkCount: pts.length,
        sei: null,
        perclos: null,
        perclosP70: null,
        perclosP80: null,
        bpm: null,
        distanceCm: null,
        alertCode: null,
        alertMessage: '',
        eyeStatus: 'Đang hiệu chuẩn ' + c.frames + '/' + c.target,
      };
    }

    const sT = this.sensTime;
    const { yawDeg, pitchDeg, rollDeg } = m;
    const yawDev = yawDeg;
    const pitchDev = pitchDeg;
    const gazeHDev = m.gazeH - this.baselineGazeH;
    const gazeVDev = m.gazeV - this.baselineGazeV;
    const poseOk = m.reliable &&
      Math.abs(yawDev) <= EYE_MAX_YAW_DEG &&
      Math.abs(pitchDev) <= EYE_MAX_PITCH_DEG;

    // --- distance ---
    const rawDist = estimateDistanceCm(pts, this.frameWidth, this.frameHeight,
      focalPx(this.frameWidth), Math.abs(this.poseYawAbs));
    let dist = rawDist === null ? null : rawDist * this.distanceScale;
    if (dist !== null && isFiniteNumber(dist)) dist = this.distFilter.filter(dist, nowMs);
    const tooClose = this.updateDistanceAlert(dist);
    this.distanceCm = dist;

    // --- eye engine ---
    const eye = this.engine.update(
      pts, this.frameWidth, this.frameHeight, nowMs,
      yawDev, pitchDev, gazeVDev, blend, poseOk,
    );
    const openness = eye.openness;
    const eyeValid = eye.valid;

    this.eyesClosed = eye.closed;
    if (eye.closed) this.closedStartMs = eye.closedStartMs;
    const closedDuration = this.eyesClosed ? nowMs - this.closedStartMs : 0;
    const drowsyNow = this.eyesClosed && closedDuration >= DROWSY_CLOSURE_MS * sT;

    if (eye.valid) {
      this.perclos.record(nowMs, eye.closed);
      this.perclosP70.record(nowMs, openness <= PERCLOS_P70_OPEN);
      this.perclosP80.record(nowMs, openness <= PERCLOS_P80_OPEN);
    } else {
      this.perclos.pause();
      this.perclosP70.pause();
      this.perclosP80.pause();
    }
    const perclosVal = this.perclos.percentOrNull(nowMs);
    const perclosForScore = perclosVal === null ? 0 : perclosVal;

    let blinkDetected = false;
    if (eye.blinkDurationMs > 0) {
      blinkDetected = true;
      this.blinkTimestamps.push(nowMs);
      this.blinkDurations.push(eye.blinkDurationMs);
      this.blinkTotal++;
    }
    while (this.blinkTimestamps.length && nowMs - this.blinkTimestamps[0] > BPM_WINDOW_MS) {
      this.blinkTimestamps.shift();
      if (this.blinkDurations.length) this.blinkDurations.shift();
    }
    const elapsed = nowMs - this.monitoringStartMs;
    const windowMs = elapsed > 0 ? Math.min(Math.max(elapsed, BPM_MIN_WINDOW_MS), BPM_WINDOW_MS) : 1;
    const bpm = this.blinkTimestamps.length * 60000 / windowMs;
    const bpmReliable = elapsed >= BPM_RELIABLE_AFTER_MS;

    // --- gaze / look-away / drift ---
    // Both entry gates carry the slider's angle factor, as MainActivity.kt:4371 and :4402 do. Without
    // it the slider only moved the timers here, and a head turned 17 degrees read as "at the screen"
    // on one device and "away" on the other.
    const headAway = (Math.abs(yawDev) > this.thrLookYaw * this.sensThr
      || Math.abs(pitchDev) > this.thrLookPitch * this.sensThr);
    if (headAway) {
      if (this.lookAwayStartMs === 0) this.lookAwayStartMs = nowMs;
    } else {
      this.lookAwayStartMs = 0;
    }
    const lookAwayLong = this.lookAwayStartMs !== 0 &&
      nowMs - this.lookAwayStartMs >= LOOK_AWAY_MS * sT;

    // One definition, used by the drift gate and by the HUD line that explains it, so the sentence
    // "your eyes were open when this was called a lie" cannot disagree with the gate.
    const eyesOpenForGaze = eyeValid && openness >= EYES_OPEN_FOR_GAZE;
    const drifting = m.irisAvailable && m.reliable && eyesOpenForGaze &&
      (Math.abs(gazeHDev) > this.thrGazeH * this.sensThr
        || Math.abs(gazeVDev) > this.thrGazeV * this.sensThr);
    if (drifting) {
      if (this.driftStartMs === 0) this.driftStartMs = nowMs;
    } else {
      this.driftStartMs = 0;
    }
    const driftLong = this.driftStartMs !== 0 && nowMs - this.driftStartMs >= VISUAL_DRIFT_MS * sT;
    const driftMs = this.driftStartMs === 0 ? 0 : nowMs - this.driftStartMs;

    // --- micro-expressions ---
    const marValue = this.mar(pts);
    const bfrValue = this.bfr(pts);
    const micro = this.updateMicroExpressions(marValue, blend, bfrValue, yawDev, nowMs);

    // --- situation layer ---
    const sf = new SituationFrame();
    sf.yawDeg = yawDev;
    sf.pitchDeg = pitchDev;
    sf.rollDeg = rollDeg;
    sf.gazeVDev = gazeVDev;
    sf.openness = eyeValid ? openness : NaN;
    sf.closedMs = closedDuration;
    sf.poseStdDeg = this.poseStdDeg();
    this.situation.update(sf, nowMs);

    // --- SEI components ---
    const posture = headScore(yawDev, pitchDev, rollDeg, this.jitter(pts));
    const distSc = distanceScore(dist, MIN_SAFE_DISTANCE_CM);
    // The sub-scores take this student's own thresholds, the way the phone's members do (gazeScore
    // MainActivity.kt:3688, bpmScore :3654). Passing the plain constants made the score itself - not
    // just the alert - disagree with the phone for any student who has a profile.
    const gazeSc = gazeScore(m.irisAvailable && m.reliable, eyesOpenForGaze,
      gazeHDev, gazeVDev, driftLong, this.thrGazeH, this.thrGazeV);
    const eyesSc = Math.max(0, (
      eyeScore(closedDuration, eye.closed, DROWSY_CLOSURE_MS)
      - clamp((perclosForScore - 5) / 25, 0, 1) * 50
      - clamp(eye.squintPct / 60, 0, 1) * 15
    ));
    const bpmSc = bpmScore(bpm, bpmReliable, this.thrBlinkLow, this.thrBlinkHigh);
    const exprSc = expressionScore(micro.yawnConfirmed, micro.yawnsRecent, bfrValue,
      this.baselineBfr, micro.confused);

    // The scene term. This is the only place layer 1 - the person and object detector - touches the
    // measurement at all: everything else it produces is a plate on the picture. person_pipeline.py
    // subtracts the same 25 from the same side of the same average, and _dev/sei-check.mjs proves the
    // two rules answer the same table.
    //
    // It stays 0 on the phone and here whenever nothing has been detected, which is why the term is
    // read from the caller rather than guessed from the frame: an absent instrument and an
    // instrument that saw no phone must not be allowed to become two different numbers.
    const contextPenalty = phoneContextPenalty(nearby, pitchDev, gazeVDev);

    let chronicLevel = 0;
    if (contextPenalty > 0 || lookAwayLong) chronicLevel = 2;
    else if (driftLong) chronicLevel = 1;

    const comps = {
      posture, dist: distSc, gaze: gazeSc, eyes: eyesSc, blinkRate: bpmSc, expression: exprSc,
    };
    const rawSei = this.sei.rawFromComponents(comps, tooClose, chronicLevel, false) - contextPenalty;
    const seiVal = this.sei.updateSei(rawSei, frameDtMs, this.sensSmooth);

    // --- 20-20-20 work clock (MainActivity.kt:4551-4560) ---
    const workMs = this.workStartMs === 0 ? 0 : nowMs - this.workStartMs;
    let breakReminder = false;
    if (workMs >= BREAK_REMINDER_MS) {
      if (workMs < BREAK_REMINDER_MS + BREAK_REMINDER_SHOW_MS) breakReminder = true;
      else this.workStartMs = nowMs;
    }

    // --- below this student's own usual level (MainActivity.kt:4642-4652) ---
    // The comparison is held for 45 s, exactly like person_pipeline.py:775-777, and reads the spread the
    // profile already floored at PERSONAL_SEI_MIN_SPREAD - flooring it a second time here would be a rule
    // the other two legs do not have. With no habit profile personalSeiMean is null, so this branch can
    // never fire here and the HUD prints no advisory line rather than inventing a "usual level".
    const belowPersonal = m.reliable && this.personalSeiMean !== null
      && this.personalSeiSpread !== null
      && seiVal < this.personalSeiMean - LOW_VS_PERSONAL_K * this.personalSeiSpread;
    if (belowPersonal) {
      if (this.lowVsPersonalStartMs === 0) this.lowVsPersonalStartMs = nowMs;
    } else {
      this.lowVsPersonalStartMs = 0;
    }
    const lowVsPersonal = this.lowVsPersonalStartMs !== 0 &&
      nowMs - this.lowVsPersonalStartMs >= LOW_VS_PERSONAL_MS;

    // --- habit accumulation (person_pipeline.py:786) ---
    // Runs before the fatigue update, on the same frame's numbers, with the same guard the phone
    // uses: a frame the eye engine did not trust or that has no SEI is not a frame worth learning from.
    // quality is null when the page could not read the light, so such a frame contributes no quality
    // sample instead of a free near-perfect one.
    this.observeHabit(nowMs, eye, bpm, bpmReliable, dist, yawDev, pitchDev, gazeHDev, gazeVDev,
      marValue, bfrValue, perclosForScore, seiVal, m.lightOk ? m.quality : null);

    const avgBlinkMs = this.blinkDurations.length
      ? this.blinkDurations.reduce((a, b) => a + b, 0) / this.blinkDurations.length : null;
    const fatigue = this.sei.updateFatigue(perclosForScore, avgBlinkMs, micro.yawnsRecent, bpm,
      bpmReliable, drowsyNow, this.thrBlinkLow, this.thrBlinkHigh, this.sensLevel, frameDtMs);

    // The chain runs once and its answer is used twice, exactly as on the phone: the counted code and
    // the printed sentence are not the same list. Three branches print but are never counted, and a
    // held alert is a delayed one, not a fired one (MainActivity.kt:4739, :5145).
    const picked = pickAlert({
      reliable: m.reliable, drowsy: drowsyNow, perclos: perclosVal, drift: driftLong,
      lookAway: lookAwayLong, yawn: micro.yawnConfirmed, bpm, bpmReliable,
      squint: eye.squintAlert, asym: eye.asymAlert, incomplete: eye.incompleteAlert,
      noisy: eye.noisy, breakReminder, confused: micro.confused, lowVsPersonal,
    }, { perclos: this.thrPerclos, blinkLow: this.thrBlinkLow, blinkHigh: this.thrBlinkHigh },
    this.situation, sf, nowMs);

    let eyeStatus;
    if (drowsyNow) eyeStatus = 'Nhắm lâu — có thể buồn ngủ';
    else if (this.eyesClosed) eyeStatus = 'Đang nhắm';
    else if (!eyeValid) eyeStatus = 'Tạm bỏ qua (góc nghiêng lớn hoặc tín hiệu kém)';
    else if (eye.squintAlert) eyeStatus = 'Mắt khép hoặc nheo một phần kéo dài';
    else eyeStatus = 'Đang mở hoặc chuyển trạng thái';

    return {
      ...m,
      calibrated: true,
      calibration: { calibrated: true, frames: this.calFrames, target: CALIBRATION_FRAMES },
      yawDeg,
      pitchDeg,
      rollDeg,
      poseOk,
      poseStdDeg: sf.poseStdDeg,
      eye,
      eyeValid,
      baselineEar: this.engine.baselineEar(),
      openness,
      gazeHDev,
      gazeVDev,
      eyesOpenForGaze,
      driftNow: drifting,
      driftLong,
      driftMs,
      lookAwayLong,
      blinkDetected,
      blinkCount: this.blinkTimestamps.length,
      blinkTotal: this.blinkTotal,
      avgBlinkMs,
      bpm,
      bpmReliable,
      drowsyNow,
      closedDuration,
      eyeStatus,
      perclos: perclosVal,
      perclosP70: this.perclosP70.percentOrNull(nowMs),
      perclosP80: this.perclosP80.percentOrNull(nowMs),
      distanceCm: dist,
      distanceScale: this.distanceScale,
      distanceCalibrated: this.distanceCalibrated,
      tooClose,
      mar: marValue,
      bfr: bfrValue,
      baselineBfr: this.baselineBfr,
      yawnConfirmed: micro.yawnConfirmed,
      yawnsRecent: micro.yawnsRecent,
      confusedSustained: micro.confused,
      furrowNow: micro.furrowNow,
      sei: seiVal,
      seiComponents: comps,
      chronicLevel,
      contextPenalty,
      fatigue,
      averageSei: this.sei.averageSei(),
      minSei: this.sei.minSei,
      situation: this.situation.situation,
      rawSituation: this.situation.rawSituation,
      intervened: this.situation.intervenedEpisodes,
      suppressed: this.situation.suppressedEpisodes,
      alertCode: picked.code,
      alertCounted: picked.counted,
      alertHeld: picked.held,
      breakReminder,
      lowVsPersonal,
      personalSeiMean: this.personalSeiMean === null ? null : Math.round(this.personalSeiMean),
      personalSeiSpread: this.personalSeiSpread,
      ...this.habitFacts(nowMs),
      workMs,
      sessionSeconds: Math.max(0, Math.floor(elapsed / 1000)),
      landmarkCount: this.landmarkCount,
      frameDtMs,
    };
  }
}
