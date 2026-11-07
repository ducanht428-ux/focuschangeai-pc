// SituationEngine, ported from edge-server/focusedge/engines.py (which mirrors MainActivity.kt).
//
// This is the layer that decides what the student is physically doing before any alert is judged, and
// it owns the one gate that protects the project from its own weakest signal: an eyelid-based alert is
// HELD (delayed, not deleted) while the head still points at the screen and the eye is above this
// situation's own openness floor. classify() and allow() must stay in this order - the hold reads the
// statistics that update() accumulates under the *current* situation, so answering them in another
// order changes which minute of video gets excused.

export const Situation = {
  FORWARD: 0,
  DOWN: 1,
  TILT: 2,
  TURNED: 3,
  DOZING: 4,
  UNKNOWN: 5,
};

export const SITUATION_VI = {
  [Situation.FORWARD]: 'Ngồi thẳng, nhìn màn hình',
  [Situation.DOWN]: 'Cúi xuống (viết hoặc đọc)',
  [Situation.TILT]: 'Nghiêng đầu',
  [Situation.TURNED]: 'Quay sang bên',
  [Situation.DOZING]: 'Gật đầu, ít cử động',
  [Situation.UNKNOWN]: '--',
};

/** Welford online mean/std, matching RunningStat in HabitModel.kt (population std, n>1). */
export class RunningStat {
  constructor() { this.n = 0; this.mean = 0; this._m2 = 0; }

  add(x) {
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this._m2 += d * (x - this.mean);
  }

  std() { return this.n > 1 ? Math.sqrt(this._m2 / this.n) : 0; }
}

export class SituationFrame {
  constructor() {
    this.yawDeg = 0;
    this.pitchDeg = 0;
    this.rollDeg = 0;
    this.gazeVDev = 0;
    this.openness = NaN;
    this.closedMs = 0;
    this.poseStdDeg = NaN;
  }
}

export class SituationEngine {
  static ALWAYS_ALERT_CLOSED_MS = 2500;
  static HOLD_MAX_MS = 700;
  static MIN_FRAMES_PER_SITUATION = 60;
  static SWITCH_HOLD_MS = 400;
  static YAW_TURN_DEG = 20;
  static ROLL_TILT_DEG = 12;
  static PITCH_DOWN_DEG = 12;
  static PITCH_DOZE_DEG = 20;
  static GAZE_DOWN = 0.25;
  static STILL_STD_DEG = 0.35;
  static DOZE_OPENNESS = 0.55;
  static DOZE_CLOSED_MS = 300;
  static BAND_K = 2.5;

  constructor(bandK = SituationEngine.BAND_K) {
    this.bandK = bandK;
    this.rawSituation = Situation.UNKNOWN;
    this.situation = Situation.UNKNOWN;
    this.intervenedEpisodes = 0;
    this.suppressedEpisodes = 0;
    this._candidate = Situation.UNKNOWN;
    this._candidateStartMs = 0;
    this._holdStartMs = 0;
    this._stats = [];
    this.reset();
  }

  reset() {
    this.rawSituation = Situation.UNKNOWN;
    this.situation = Situation.UNKNOWN;
    this._candidate = Situation.UNKNOWN;
    this._candidateStartMs = 0;
    this._holdStartMs = 0;
    this.intervenedEpisodes = 0;
    this.suppressedEpisodes = 0;
    this._stats = Array.from({ length: 6 }, () => new RunningStat());
  }

  framesIn(s) { return this._stats[s].n; }

  classify(f) {
    if (Math.abs(f.yawDeg) > SituationEngine.YAW_TURN_DEG) return Situation.TURNED;
    const pitched = f.pitchDeg > SituationEngine.PITCH_DOWN_DEG;
    const gazesDown = f.gazeVDev > SituationEngine.GAZE_DOWN;
    const still = Number.isFinite(f.poseStdDeg) && f.poseStdDeg < SituationEngine.STILL_STD_DEG;
    if (pitched && f.pitchDeg > SituationEngine.PITCH_DOZE_DEG && still
      && f.openness < SituationEngine.DOZE_OPENNESS && f.closedMs >= SituationEngine.DOZE_CLOSED_MS) {
      return Situation.DOZING;
    }
    if (Math.abs(f.rollDeg) > SituationEngine.ROLL_TILT_DEG) return Situation.TILT;
    if (pitched || gazesDown) return Situation.DOWN;
    return Situation.FORWARD;
  }

  update(f, nowMs) {
    const raw = this.classify(f);
    this.rawSituation = raw;
    if (raw === this.situation) {
      this._candidate = raw;
      this._candidateStartMs = 0;
    } else if (this.situation === Situation.UNKNOWN) {
      this._candidate = raw;
      this._candidateStartMs = 0;
      this.situation = raw;
    } else if (raw !== this._candidate) {
      this._candidate = raw;
      this._candidateStartMs = nowMs;
    } else if (nowMs - this._candidateStartMs >= SituationEngine.SWITCH_HOLD_MS) {
      this._candidateStartMs = 0;
      this.situation = this._candidate;
    }
    if (Number.isFinite(f.openness)) this._stats[this.situation].add(f.openness);
  }

  opennessFloor(s) {
    const st = this._stats[s];
    if (st.n < SituationEngine.MIN_FRAMES_PER_SITUATION) return NaN;
    return st.mean - this.bandK * st.std();
  }

  /** True = the alert may fire now; false = it is being held because the situation says the eye is fine. */
  allow(eyelidEvidence, f, nowMs) {
    if (!eyelidEvidence) {
      if (this._holdStartMs !== 0) this.suppressedEpisodes++;
      return this._clearHold();
    }
    if (f.closedMs >= SituationEngine.ALWAYS_ALERT_CLOSED_MS) return this._clearHold();
    if (this.situation === Situation.DOZING || this.situation === Situation.UNKNOWN) return this._clearHold();
    const floor = this.opennessFloor(this.situation);
    if (!Number.isFinite(floor)) return this._clearHold();
    if (f.openness >= floor) {
      if (this._holdStartMs === 0) {
        this._holdStartMs = nowMs;
        this.intervenedEpisodes++;
      }
      if (nowMs - this._holdStartMs < SituationEngine.HOLD_MAX_MS) return false;
    } else {
      this._holdStartMs = 0;
    }
    return this._clearHold();
  }

  _clearHold() {
    this._holdStartMs = 0;
    return true;
  }
}
