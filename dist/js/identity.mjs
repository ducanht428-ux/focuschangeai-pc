// Face identity for the shared school computer.
//
// The problem this solves: the roster in store.mjs is picked by hand, so on a machine that several
// students sit at in sequence, whoever opens the page inherits the last student's baseline. The camera
// has to answer "who is this" before the run is bound.
//
// What is available offline: the vendored MediaPipe bundle exports FaceLandmarker, FaceDetector,
// GestureRecognizer and ImageClassifier - there is no FaceEmbedder and no embedding model in dist/, so
// a real face-recognition vector would mean shipping a new binary. This leg therefore measures geometry
// from the 478-point mesh the page already asks for. Distances between rigid facial landmarks, divided
// by the inter-eye distance, are invariant to where the face is, how big it is and how far it sits from
// the camera, which is exactly the drift a fixed webcam at a booth produces. They are NOT invariant to
// yaw: turning the head compresses the far side, so the sample bank holds several poses per student and
// a match is judged against the closest one rather than against a mean.
//
// Consequence to keep honest: this separates a handful of students at one desk. It is not an
// identification system for a whole class, and it never claims one - the numbers it prints (d, r,
// margin) are what the operator judges, and the switch only ever proposes.
//
// Two things the module now refuses to do with a frame it cannot trust, because both were measured to
// cost more than they give:
// - a head turned away from the lens. A yaw of 20 deg moves this signature by 0.35 units, which is the
//   whole distance between two different faces (probe-gate.mjs, synthetic head, 2026-11-07), so a turned
//   child is exactly as confusing as a stranger. faceGate() says so instead of voting.
// - 20 numbers averaged as if they were equally reliable. The jaw and cheek widths jitter several times
//   more than the nose lengths, and plain Euclidean distance lets the noisiest dimension pick the winner.
//   FaceMatcher weights each dimension by its own measured noise, rescaled so the distance keeps the
//   units R_FLOOR was tuned in when every dimension is equally noisy; with a bank too thin to measure
//   the noise it falls back to the unweighted distance rather than inventing weights.
//
// Pure math: no DOM, no camera, no localStorage. index.html feeds landmarks in and gets a proposal
// out; store.mjs stays the only file that persists anything.

export const IDENTITY = {
  // One signature is one frame's answer, and one frame is not enough to act on: the mesh jitters by
  // more than the gap between two students when the light is bad. NEED agreeing frames at VOTE_MS is
  // that many seconds of the same face, and the switch stays conservative.
  VOTE_MS: 1000,
  // Four, not the three this leg shipped with. One more second of the same face is the cheapest
  // certainty available here: it costs nothing per frame and a flicker cannot survive it.
  NEED: 4,
  // "Học mặt" holds for this long and samples every LEARN_MS, so a student who sways still covers
  // three or four poses inside one press.
  LEARN_MS: 260,
  LEARN_HOLD_MS: 4000,
  SAMPLES: 14,
  // A seat change is what this feature is for. Requiring the face to have vanished first means a
  // misread never re-binds a run that is already under way: the sitting in progress is committed to
  // the student it started with, and only an empty chair lets a new name in.
  VACANCY_MS: 1500,
  // Two auto-switches cannot come closer than this, so one flickering match cannot churn the roster.
  MIN_HOLD_MS: 20000,
  // A student enrolled from one pose has spread 0 and would match anything. The floor is the price of
  // a thin enrolment; R_SPREAD turns each student's own pose range into their own radius, so the
  // student who was sampled sloppily is held loosely instead of everyone being held tightly.
  //
  // 0.30, chosen 2026-11-11 against probe-gate.mjs, which puts the smallest straight-on distance
  // between two different synthetic faces at 0.364 in these units. At 0.35 the bar sat at 96% of that
  // gap, so a classmate could walk inside it; at 0.30 it asks for 82%. This is a synthetic-head number
  // like every other one in this file - no real pair of children has been measured against it, which is
  // why the plate prints d and r instead of a bare yes/no and why the operator's dropdown still wins.
  R_FLOOR: 0.30,
  R_SPREAD: 1.8,
  // The runner-up has to be this much worse than the winner. Without it, a student with one tight
  // sample wins by a hair over the right answer and the page silently rebinds.
  //
  // 1.60, up from 1.25 with the same reasoning as R_FLOOR: at 1.25 a second candidate 25% worse was
  // enough to attach a name, and a name attached to a run is much harder to take back than a number.
  // A head in a two-child frame now has to beat its runner-up by 60% to be called by name at all -
  // assignFaces() enforces this, it used to only flag it.
  MARGIN: 1.60,
  // faceGate() thresholds. `learn` is deliberately looser than `match`: the sample bank is the only
  // place poses get recorded, so a moderately turned frame is worth keeping while enrolling, and the
  // same frame must not be allowed to choose a name. Both pairs sit at the angle where the probe put
  // the yaw damage around one whole inter-student distance, and the probe's head is a synthetic one -
  // if it exaggerates the nose, the real threshold simply sits at a larger angle, which refuses fewer
  // frames rather than freezing the page.
  YAW_MATCH_ASYM: 0.30,
  YAW_MATCH_SHIFT: 0.16,
  YAW_LEARN_ASYM: 0.38,
  YAW_LEARN_SHIFT: 0.28,
  // A silhouette point this close to the frame border means the head is cut off, and half a face is
  // measured as a narrower face.
  EDGE: 0.015,
  // Weights are only trusted once the noise has actually been observed: at least two students and this
  // many degrees of freedom across the bank (two students of four frames gives 6).
  MIN_SIGMA_DOF: 6,
  // A dimension measured as almost noise-free would otherwise be divided by its own near-zero sigma and
  // amplified without bound, so every sigma is floored at this fraction of the average noise.
  SIGMA_FLOOR: 0.25,
  // Below this the bank is not quiet, it is a copy of itself: enrolment from a held camera gives
  // identical vectors, and the pooled spread then measures as float rounding rather than as noise. That
  // number is meaningless as a scale - measured, an all-identical two-student bank turned the 0.364
  // between the two synthetic faces into 1.146, which would have refused a name for arithmetic reasons.
  // A bank this flat gets the plain distance instead.
  NOISE_MIN: 1e-6,
};

// Indices in MediaPipe's 478-point face mesh. Written as names because a bare number in a distance
// list is unreadable, and each one is a corner or a midline point that does not move with expression -
// the eyelid and lip lines are deliberately absent, since blinking would change the signature.
const L = {
  eyeOuterL: 33, eyeInnerL: 133, eyeUpperL: 159, eyeLowerL: 145,
  eyeOuterR: 362, eyeInnerR: 263, eyeUpperR: 386, eyeLowerR: 374,
  browOuterL: 107, browOuterR: 336,
  noseRoot: 4, noseBridge: 6, noseTip: 1, noseBase: 2, wingL: 98, wingR: 327,
  mouthL: 61, mouthR: 291,
  cheekL: 50, cheekR: 280, cheekMidL: 116, cheekMidR: 345,
  jawL: 234, jawR: 454, chin: 152,
};

// The two eye centres are averages of the four ring points rather than iris indices 468/473: those two
// come from a separate iris pass and are absent when the model runs without iris output.
function eyeCentres(pts) {
  const a = pts[L.eyeOuterL], b = pts[L.eyeInnerL], c = pts[L.eyeUpperL], d = pts[L.eyeLowerL];
  const e = pts[L.eyeOuterR], f = pts[L.eyeInnerR], g = pts[L.eyeUpperR], h = pts[L.eyeLowerR];
  if (!a || !b || !c || !d || !e || !f || !g || !h) return null;
  return [
    { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 },
    { x: (e.x + f.x + g.x + h.x) / 4, y: (e.y + f.y + g.y + h.y) / 4 },
  ];
}

function dist(p, q) {
  const dx = p.x - q.x, dy = p.y - q.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * A student's face as 20 pose-and-scale-invariant numbers, or null when the frame cannot be trusted.
 *
 * Everything is divided by the inter-eye distance, so the same face at 30 cm and at 80 cm gives the same
 * vector - which is the whole reason this leg can identify anybody on a webcam nobody has calibrated.
 * x and y only: the mesh's z is a relative depth with no fixed unit, and a ratio through it would move
 * with the model's own confidence rather than with the face.
 */
export function faceSignature(pts) {
  if (!Array.isArray(pts) || pts.length < L.jawR + 1) return null;
  const eyes = eyeCentres(pts);
  if (!eyes) return null;
  const D = dist(eyes[0], eyes[1]);
  // A face that small is a few pixels across: the ring average and every distance under it are noise,
  // and noise enrolled as identity is worse than no identity at all.
  if (!(D > 0.045) || !isFinite(D)) return null;
  const at = (i) => pts[i];
  const eL = eyes[0], eR = eyes[1];
  const tip = at(L.noseTip), chin = at(L.chin);
  const mL = at(L.mouthL), mR = at(L.mouthR);
  const oL = at(L.eyeOuterL), oR = at(L.eyeOuterR);
  if (!tip || !chin || !mL || !mR || !oL || !oR) return null;
  const tl = dist(tip, mL), tr = dist(tip, mR);
  const cl = dist(chin, eL), cr = dist(chin, eR);
  const ol = dist(oL, mL), or_ = dist(oR, mR);
  const v = [
    dist(at(L.noseRoot), tip) / D,
    dist(at(L.noseBase), tip) / D,
    dist(at(L.wingL), at(L.wingR)) / D,
    dist(mL, mR) / D,
    dist(at(L.jawL), at(L.jawR)) / D,
    dist(at(L.cheekL), at(L.cheekR)) / D,
    dist(at(L.cheekMidL), at(L.cheekMidR)) / D,
    dist(at(L.browOuterL), at(L.browOuterR)) / D,
    dist(chin, tip) / D,
    cl / D,
    cr / D,
    tl / D,
    tr / D,
    ol / D,
    or_ / D,
    dist(at(L.browOuterL), oL) / D,
    dist(at(L.browOuterR), oR) / D,
    dist(at(L.noseBridge), tip) / D,
    (tl - tr) / D,
    (cl - cr) / D,
  ];
  // One NaN landmark - the mesh loses the nose in profile - would otherwise poison the distance and
  // hand the frame to the closest student as a fluke.
  for (const x of v) if (!isFinite(x)) return null;
  return v;
}

function euclid(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// The points whose position says how much of the head is still inside the picture: jaw corners, chin,
// outer brows, forehead, outer eye corners, mouth corners. MediaPipe returns normalized coordinates, so
// a face reaching past the left edge shows up as x < 0 rather than as a clipped mesh.
const SILHOUETTE = [10, 107, 336, 33, 362, 234, 454, 61, 291, 152];

/**
 * Is this frame fit to be trusted with a name? null means yes, otherwise the reason plus its numbers.
 *
 * Two failures cost more than a declined frame. A head turned toward the wall compresses the far side,
 * and the compression moves all 20 numbers the same way a different person does. A head at the edge of
 * the picture loses its jaw corner, which reads as a narrower face - and with "Ghi cùng lúc" on, a
 * narrower face can be written into the neighbour's profile.
 *
 * Both measures are computed from distances and a projection along the eye line, so an in-plane tilt
 * (a child resting on an elbow, which rotates the whole mesh) does not trip them: rotation leaves the
 * distances alone, and the projection follows the eye axis instead of the frame's x.
 *
 * Neither measure alone is trusted, and the synthetic head shows why twice over: the mouth asymmetry is
 * also what a lopsided smile produces, and past roughly 60 degrees of yaw it is not even monotone - the
 * far mouth corner passes under the nose and the difference shrinks again. The nose offset grows steadily
 * and is nearly expression-free, so the pair refusing together is about pose rather than about grinning.
 *
 * Pitch is NOT gated, and that is a documented hole: the vertical compression of a head tilted up or
 * down cannot be told apart from a long or short face without knowing whose face it is, so any threshold
 * here would refuse short-faced children rather than tilted ones.
 *
 * @param {number} mode  'match' for a frame that may decide a name, 'learn' for one being enrolled
 */
export function faceGate(pts, mode) {
  if (!Array.isArray(pts) || pts.length < L.jawR + 1) return { reason: 'mesh', asym: null, shift: null };
  const eyes = eyeCentres(pts);
  if (!eyes) return { reason: 'mesh', asym: null, shift: null };
  const D = dist(eyes[0], eyes[1]);
  if (!(D > 0.045) || !isFinite(D)) return { reason: 'small', asym: null, shift: null };
  const tip = pts[L.noseTip], mL = pts[L.mouthL], mR = pts[L.mouthR];
  if (!tip || !mL || !mR) return { reason: 'mesh', asym: null, shift: null };
  const tl = dist(tip, mL), tr = dist(tip, mR);
  if (!(tl + tr > 0)) return { reason: 'mesh', asym: null, shift: null };
  const asym = Math.abs(tr - tl) / (tl + tr);
  const ux = (eyes[1].x - eyes[0].x) / D, uy = (eyes[1].y - eyes[0].y) / D;
  const mx = (eyes[0].x + eyes[1].x) / 2, my = (eyes[0].y + eyes[1].y) / 2;
  const shift = Math.abs(((tip.x - mx) * ux + (tip.y - my) * uy)) / D;
  let edgeDist = Infinity;
  for (const i of SILHOUETTE) {
    const p = pts[i];
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return { reason: 'mesh', asym, shift };
    edgeDist = Math.min(edgeDist, p.x, p.y, 1 - p.x, 1 - p.y);
  }
  const learn = mode === 'learn';
  const numbers = { asym, shift, edge: edgeDist };
  if (edgeDist < IDENTITY.EDGE) return { reason: 'clip', ...numbers };
  // Both measures must agree before a frame is refused - see the two notes above.
  if (asym > (learn ? IDENTITY.YAW_LEARN_ASYM : IDENTITY.YAW_MATCH_ASYM)
    && shift > (learn ? IDENTITY.YAW_LEARN_SHIFT : IDENTITY.YAW_MATCH_SHIFT)) {
    return { reason: 'yaw', ...numbers };
  }
  return null;
}

/**
 * The sample bank, the per-student radius it implies, and the vote that turns matches into one switch.
 */
export class FaceMatcher {
  constructor(opts) {
    const {
      maxSamples = IDENTITY.SAMPLES,
      need = IDENTITY.NEED,
      rFloor = IDENTITY.R_FLOOR,
      rSpread = IDENTITY.R_SPREAD,
      margin = IDENTITY.MARGIN,
      useWeights = true,
    } = opts || {};
    this.maxSamples = maxSamples;
    this.need = need;
    this.rFloor = rFloor;
    this.rSpread = rSpread;
    this.margin = margin;
    // Only exists so the two metrics can be compared on the same bank - the page never sets it.
    this.useWeights = useWeights;
    this.bank = new Map();
    this.voteId = null;
    this.voteCount = 0;
    this.dims = 0;
    // Cached per-dimension noise, dropped whenever the bank changes. null means "not measured yet".
    this._w = null;
  }

  /**
   * Per-dimension noise measured from the bank itself, or null when the bank is too thin to know it.
   *
   * The dimensions are not equally trustworthy: the jaw and cheek widths ride on a long lever arm from
   * one jittering landmark, the nose lengths sit between two stable ones. Pooled within-student variance
   * is the honest estimate available on a school machine - it is the noise the mesh makes on one face,
   * averaged over every face, with the between-face difference removed rather than baked into the scale.
   *
   * The result is rescaled by the root-mean-square sigma, so a bank whose dimensions are all equally
   * noisy gives exactly the plain Euclidean distance: R_FLOOR, R_SPREAD and the printed d keep the units
   * they were tuned in, and only the split between dimensions moves.
   */
  sigmas() {
    if (!this.useWeights) return null;
    if (this._w) return this._w.sigma;
    const n = this.dims;
    if (!n) return null;
    const acc = new Float64Array(n);
    let dof = 0, students = 0;
    for (const list of this.bank.values()) {
      if (list.length < 2) continue;
      students++;
      const mean = new Float64Array(n);
      for (const v of list) for (let i = 0; i < n; i++) mean[i] += v[i];
      for (let i = 0; i < n; i++) mean[i] /= list.length;
      for (const v of list) {
        for (let i = 0; i < n; i++) {
          const d = v[i] - mean[i];
          acc[i] += d * d;
        }
      }
      dof += list.length - 1;
    }
    if (students < 2 || dof < IDENTITY.MIN_SIGMA_DOF) return null;
    const sigma = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) { sigma[i] = Math.sqrt(acc[i] / dof); sum += sigma[i] * sigma[i]; }
    const rms = Math.sqrt(sum / n);
    if (!(rms > IDENTITY.NOISE_MIN)) return null;
    let floored = 0;
    for (let i = 0; i < n; i++) {
      sigma[i] = Math.max(sigma[i], IDENTITY.SIGMA_FLOOR * rms);
      floored += sigma[i] * sigma[i];
    }
    this._w = { sigma, scale: Math.sqrt(floored / n) };
    return sigma;
  }

  /** True when distances are being weighted - the HUD prints this, because it changes what d means. */
  weightsActive() {
    return this.sigmas() !== null;
  }

  /**
   * Distance between two signatures in the units every threshold here is tuned in: weighted when the
   * bank has measured the noise, plain Euclidean while it has not.
   */
  gdist(a, b) {
    const sigma = this.sigmas();
    if (!sigma) return euclid(a, b);
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = (a[i] - b[i]) / sigma[i];
      s += d * d;
    }
    return this._w.scale * Math.sqrt(s);
  }

  /** Load what store.mjs kept. A stored vector of a different length is a different build and is dropped. */
  setBank(map) {
    this.bank = new Map();
    this.dims = 0;
    this._w = null;
    for (const s of studentsOrEntries(map)) {
      for (const v of s.list) {
        if (Array.isArray(v) && v.length && (!this.dims || this.dims === v.length)) this.dims = v.length;
      }
    }
    for (const s of studentsOrEntries(map)) {
      const keep = (s.list || []).filter((v) => Array.isArray(v) && v.length === this.dims);
      if (keep.length) this.bank.set(s.id, keep.slice(0, this.maxSamples));
    }
    this.resetVotes();
    return this;
  }

  students() {
    return [...this.bank.keys()];
  }

  count(id) {
    return (this.bank.get(id) || []).length;
  }

  /** The stored vectors, copied out so the page can hand them to store.mjs unchanged. */
  samples(id) {
    return (this.bank.get(id) || []).slice();
  }

  /**
   * How far this student sits from every other one - the number that says whether two banks can be told
   * apart at all, and the reason "Học mặt" prints it instead of only printing the radius.
   */
  separation(id) {
    const mine = this.bank.get(id) || [];
    const out = [];
    for (const [other, list] of this.bank) {
      if (other === id || !mine.length || !list.length) continue;
      let best = Infinity;
      for (const a of mine) {
        for (const b of list) best = Math.min(best, this.gdist(a, b));
      }
      if (isFinite(best)) out.push({ id: other, dist: best });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** True when the frame was good enough to keep. The caller says so out loud either way. */
  addSample(id, vec) {
    if (!Array.isArray(vec) || vec.some((x) => !isFinite(x))) return false;
    if (this.dims && vec.length !== this.dims) return false;
    this.dims = vec.length;
    const list = this.bank.get(id) || [];
    list.push(vec);
    // Keeping the newest is not a preference: the oldest samples came from the light and the seat that
    // were there the first time somebody pressed the button, and a run today is measured today.
    this.bank.set(id, list.slice(-this.maxSamples));
    this._w = null;
    return true;
  }

  drop(id) {
    this.bank.delete(id);
    this._w = null;
    this.resetVotes();
  }

  /** How far this student's own samples sit from each other - their pose range, in signature units. */
  spread(id) {
    const list = this.bank.get(id) || [];
    let worst = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) worst = Math.max(worst, this.gdist(list[i], list[j]));
    }
    return worst;
  }

  radius(id) {
    return Math.max(this.rFloor, this.rSpread * this.spread(id));
  }

  /** Closest stored sample per student, best first, each with its own radius and how full it is. */
  ranked(vec) {
    const per = [];
    for (const [id, list] of this.bank) {
      let best = Infinity;
      for (const v of list) best = Math.min(best, this.gdist(vec, v));
      if (!isFinite(best)) continue;
      const radius = this.radius(id);
      per.push({ id, dist: best, radius, ratio: best / radius, inside: best <= radius });
    }
    return per.sort((a, b) => a.ratio - b.ratio);
  }

  /**
   * How many times worse the runner-up is than the winner, in ratio units.
   *
   * Infinity when there is nothing to compare with, and also when the winner sits exactly on a stored
   * sample: a bank enrolled from a held camera produces ratio 0, and dividing by it would report a
   * meaningless lead for a frame that is simply a copy of what was enrolled.
   */
  lead(per) {
    if (per.length < 2 || !(per[0].ratio > 0)) return Infinity;
    return per[1].ratio / per[0].ratio;
  }

  /**
   * Every student this one frame could be, best first, without picking a winner.
   *
   * assignFaces() needs the whole ranking: when two children sit in the same frame, the decision is not
   * "which student is face A" twice in isolation, it is one assignment over both faces, and a face whose
   * top answer is already taken has to say so instead of quietly wearing the other name.
   */
  matchAll(vec) {
    if (!Array.isArray(vec) || vec.length !== this.dims) return [];
    return this.ranked(vec);
  }

  /**
   * Closest stored frame per student, then the two that are nearest overall.
   *
   * The winner is the smallest distance divided by that student's own radius, not the raw distance:
   * a student enrolled across four poses is allowed to be matched loosely, and a student enrolled from
   * one straight-on frame is not allowed to swallow the room.
   *
   * `why` names the bar a refused frame missed - 'radius' (too far from the bank) or 'margin' (a
   * classmate is nearly as close) - because an operator who sees only "không chắc" cannot tell an
   * unsure machine from a stranger, and those are different things to act on.
   */
  match(vec) {
    if (!Array.isArray(vec) || vec.length !== this.dims || this.bank.size === 0) return null;
    const per = this.ranked(vec);
    if (!per.length) return null;
    const first = per[0];
    const second = per[1] || null;
    const lead = this.lead(per);
    const clear = lead >= this.margin;
    return {
      id: first.id,
      dist: first.dist,
      radius: first.radius,
      ratio: first.ratio,
      second: second ? second.id : null,
      secondRatio: second ? second.ratio : null,
      lead,
      inside: first.inside,
      clear,
      ok: first.inside && clear,
      why: !first.inside ? 'radius' : (clear ? null : 'margin'),
    };
  }

  /** NEED agreeing frames in a row, and only NEED in a row: any different answer restarts the count. */
  vote(id) {
    if (id !== this.voteId) {
      this.voteId = id;
      this.voteCount = 0;
    }
    this.voteCount++;
    return this.voteCount >= this.need ? id : null;
  }

  resetVotes() {
    this.voteId = null;
    this.voteCount = 0;
  }

  /** How many frames the current candidate has agreed on - printed, because "2/4" explains a switch. */
  get voting() {
    return { id: this.voteId, count: this.voteCount };
  }
}

/** Sorting offset that puts a gated head behind every readable one, large enough to beat any ratio. */
const GATED_LAST = 1e6;

/**
 * One assignment for every face in the frame, so two children at once get two different names.
 *
 * The most confident face is settled first, because a sharp, well-lit face knows who it is better than a
 * half-turned one in the corner does, and the loose face must not get to claim the name first. A face
 * whose best student is already taken is left unnamed and comes back flagged, because "em thứ hai trùng
 * tên bạn bên cạnh" is a fact the operator has to see, and the next candidate on the list is not a
 * second opinion - it is a name that lost a contest.
 *
 * A head that fails either certainty bar is left unnamed too: the radius it must sit inside, and the
 * lead over its runner-up. Before this the crowded-frame path checked only the radius and put the
 * near-tie in the label as advice. A name beside a head is not a caption any more than a number is:
 * with "Ghi cùng lúc" on it opens that child's profile and writes a run into it, so the two children in
 * one frame now clear the same bar the one child in the dropdown clears. `why` says which one missed.
 *
 * @param {Array<number[]|null>} sigs  one signature per detected face, same order as faceLandmarks
 * @param {FaceMatcher} matcher
 * @param {Array<object|null>} [gates]  faceGate() answer per face, same order. A gated head is settled
 *   last, so a child turned toward the wall cannot claim a name and leave the clear-faced one next to
 *   them wearing nothing; it still gets a name when no one else wants it, because its own run must keep
 *   ticking while it looks at its book.
 * @returns {Array} [{index, id, dist, radius, ratio, lead, inside, taken, ambiguous, why, gated}]
 */
export function assignFaces(sigs, matcher, gates) {
  const rows = sigs.map((sig, index) => ({
    index,
    cands: matcher.matchAll(sig),
    gated: !!(gates && gates[index]),
  }));
  const rank = (r) => (r.cands[0] ? r.cands[0].ratio : Infinity) + (r.gated ? GATED_LAST : 0);
  const order = rows.slice().sort((a, b) => rank(a) - rank(b));
  const taken = new Set();
  const out = new Array(sigs.length).fill(null);
  for (const row of order) {
    if (!row.cands.length) {
      out[row.index] = { index: row.index, id: null, cands: [], gated: row.gated, why: 'empty' };
      continue;
    }
    const top = row.cands[0];
    const lead = matcher.lead(row.cands);
    const clear = lead >= matcher.margin;
    const displaced = taken.has(top.id);
    const why = !top.inside ? 'radius' : (clear ? null : 'margin');
    // No fallback: when the winner is already worn by another head, this head is not "the next student
    // on the list", it is an unplaced one. The alternative candidates are all worse than a name that
    // just lost a contest, and a borrowed name would attach the wrong profile to a scored run. The
    // page says "trùng tên bạn bên cạnh" and the operator keeps the dropdown.
    const hit = displaced || why ? null : top;
    if (hit) taken.add(hit.id);
    out[row.index] = {
      index: row.index,
      id: hit ? hit.id : null,
      dist: top.dist,
      radius: top.radius,
      ratio: top.ratio,
      lead,
      inside: top.inside,
      taken: displaced,
      gated: row.gated,
      ambiguous: row.cands.length > 1 && !clear,
      why: displaced ? 'taken' : why,
      cands: row.cands,
    };
  }
  return out;
}

/** store.mjs hands back {id: [vec]}; a Map works too, and the page passes either. */
function studentsOrEntries(map) {
  if (map instanceof Map) return [...map.entries()].map(([id, list]) => ({ id, list }));
  return Object.entries(map || {}).map(([id, list]) => ({ id, list }));
}
