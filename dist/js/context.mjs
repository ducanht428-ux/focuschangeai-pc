// Classroom Context Engine - the rule-based layer that names what the room is doing.
//
// What this file is for, and what it deliberately is not. The plan the class handed over asks for a
// "Classroom Context Engine" that labels seven activity types (học cá nhân, thảo luận nhóm, làm việc
// cặp, thuyết trình, thực hành, đọc/viết, nghỉ giải lao) from the camera signals, and behind it a
// trained behaviour classifier (RandomForest, then XGBoost, then LSTM) fed by an interaction dataset.
// The trained half cannot live here: this leg has no labelled dataset - nothing in either checkout has
// ever written one - and the browser measurements on this laptop (1.2-1.4 s per YOLO pass, no
// SharedArrayBuffer, WebGPU hanging on the gen-8 chip) leave no room for a scikit-learn or a Whisper
// run. So this file is the rule-based half only: deterministic, readable, testable in Node, built
// entirely from numbers the shipped pipeline already measures. The trained classifier stays roadmap,
// and no sentence in this project may quote an accuracy for what follows, because none exists.
//
// Every threshold below is a HEURISTIC chosen to match the geometry of the signals, not a value fitted
// to labelled classroom video. The HUD says so in the same line as the label, and test-context.mjs
// pins the wording so a future edit cannot quietly drop it.

import { LM_FACE_LEFT, LM_NOSE_TIP, RIGHT_EYE, LEFT_EYE, computeHeadPose } from './measure.mjs';
import { ownerOf } from './detect.mjs';
import { BREAK_DETECT_MS } from './params.mjs';

export const ClassContext = {
  UNKNOWN: 0,
  INDIVIDUAL_STUDY: 1,
  GROUP_DISCUSSION: 2,
  PAIR_WORK: 3,
  PRESENTATION: 4,
  PRACTICE: 5,
  READING: 6,
  BREAK: 7,
};

// Vietnamese for the column. READING is spelled "đọc hoặc viết" on purpose: pen, pencil and notebook are
// not COCO classes at all (see detect.mjs), so a head bent over a desk cannot be told apart from a head
// bent over a book, and a label that said only "đọc sách" would claim a distinction this camera cannot
// see. Same reason PRACTICE names a device rather than hands.
export const CLASS_CONTEXT_VI = {
  [ClassContext.UNKNOWN]: 'chưa rõ hoạt động',
  [ClassContext.INDIVIDUAL_STUDY]: 'học cá nhân',
  [ClassContext.GROUP_DISCUSSION]: 'thảo luận nhóm',
  [ClassContext.PAIR_WORK]: 'làm việc cặp',
  [ClassContext.PRESENTATION]: 'thuyết trình',
  [ClassContext.PRACTICE]: 'thực hành (thiết bị)',
  [ClassContext.READING]: 'đọc hoặc viết (cúi đầu)',
  [ClassContext.BREAK]: 'nghỉ giải lao',
};

// Object sets, spelled with detect.mjs's own names so a rename there is a rename here. They are written
// as literals rather than derived from CONTEXT_VI because the split is a judgement about classrooms,
// not a partition of COCO: a chair would make every frame a break, and furniture stays out of the
// detector for that reason already.
export const PRACTICE_OBJECTS = ['laptop', 'mouse', 'keyboard', 'tv', 'scissors'];
export const READING_OBJECTS = ['book'];
export const BREAK_OBJECTS = [
  // food and tableware: what a Vietnamese primary-school desk holds at a break
  'cup', 'bottle', 'wine glass', 'bowl', 'fork', 'knife', 'spoon',
  'banana', 'apple', 'sandwich', 'orange', 'carrot', 'broccoli', 'hot dog', 'pizza', 'donut', 'cake',
  // packing up, and the toys that come out when work stops
  'backpack', 'handbag', 'teddy bear',
  'sports ball', 'kite', 'frisbee', 'skateboard', 'tennis racket', 'baseball bat', 'baseball glove',
  'umbrella',
];

export const CONTEXT_T = {
  // |yaw| and |pitch| under this counts as "facing the lens". 25 rather than the ~12 the eye pipeline
  // uses, because these are ABSOLUTE angles: only the measured student has a per-profile baseline
  // subtracted (session.mjs:590), so a child who sits sideways to the camera carries that angle all
  // day. A tighter gate would call a sideways seat a discussion.
  FORWARD_YAW_DEG: 25,
  FORWARD_PITCH_DEG: 25,
  // Bent far enough over the desk that "looking at the screen" is no longer the plain reading.
  DOWN_PITCH_DEG: 22,
  // The nose offset, in eye-distance units (the same normalisation faceGate's shift uses, whose
  // match-mode gate sits at 0.16). Direction only needs a consistent sign, not a full turn, so this
  // floor is half of that gate: below it the vector is noise about a face that is pointing forward.
  TURN_SHIFT: 0.08,
  // cos of the angle between "where this head points" and "the line to that head". 0.45 is about 63
  // degrees, so a head has to point roughly - not exactly - at the neighbour.
  AIM_COS: 0.45,
  // Two heads this far apart in normalised frame space are not at one table, whatever they point at.
  CLUSTER_SPAN: 0.5,
  // Object confidence floor, copied from CONTEXT_PHONE_CONF: a box that survives one pass only - a
  // neighbour's desk, a bag on the floor - must not move a label either.
  OBJ_CONF: 0.4,
  // A presenter is closer to the lens than the class by at least this factor of eye span.
  PRESENTER_SPAN: 1.5,
  // How long the raw rules must agree on a new label before the column switches. The situation layer
  // holds for 400 ms of head posture; a classroom activity is a slower thing and 1.5 s of agreement
  // is the shortest hold that survives one child turning his head for a second.
  HOLD_MS: 1500,
  // The loop only rebuilds signals this often; between samples the last snapshot is reused. This is
  // pure arithmetic over landmarks the frame already has, but it runs per head and the 2-core laptop
  // has a 33 ms budget, so it is paced like the detector rather than like the drawing.
  SAMPLE_MS: 100,
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Per-head geometry, from the mesh the frame already produced.
 *
 * Two families of numbers come out, and the split matters. Angles come from computeHeadPose and are
 * ABSOLUTE, so they are only trusted for the loose "facing the lens" gate. The direction vector is
 * derived instead from where the nose tip sits relative to the eye line: that offset is a fact about
 * this image, in this image's coordinates, so "head A points toward head B" needs no assumption about
 * which way a positive yaw means, no mirroring convention, and no per-seat baseline. A turned head and
 * a target are compared with a dot product of two vectors that both live in the same space.
 *
 * @param {Array<Array<{x:number,y:number,z:number}>>} faces  res.faceLandmarks, one array per head
 * @param {number} width   canvas width, only used to ask who owns which objects
 * @param {number} height
 * @param {Array<object>} persons  boxes.persons, each carrying its .nearby map (may be empty)
 */
export function headSignals(faces, width, height, persons) {
  const out = [];
  for (const pts of faces || []) {
    if (!Array.isArray(pts) || pts.length < LEFT_EYE[3] + 1) continue;
    const centre = (ring) => {
      let x = 0, y = 0;
      for (const i of ring) {
        if (!pts[i] || !finite(pts[i].x) || !finite(pts[i].y)) return null;
        x += pts[i].x; y += pts[i].y;
      }
      return { x: x / ring.length, y: y / ring.length };
    };
    // Averaging six ring points per eye; identity.mjs averages four of the same ring for its signature.
    const e0 = centre(RIGHT_EYE), e1 = centre(LEFT_EYE), tip = pts[LM_NOSE_TIP];
    if (!e0 || !e1 || !tip || !finite(tip.x) || !finite(tip.y)) continue;
    const dx = e1.x - e0.x, dy = e1.y - e0.y;
    const span = Math.hypot(dx, dy);
    if (!(span > 0.02)) continue;
    const ux = dx / span, uy = dy / span;
    const mx = (e0.x + e1.x) / 2, my = (e0.y + e1.y) / 2;
    // Signed, unlike faceGate's shift: the sign IS the information this layer needs and |shift| is the
    // strength of the turn. The unit vector it implies points at the side the face is aimed toward.
    const shift = ((tip.x - mx) * ux + (tip.y - my) * uy) / span;
    const sgn = shift >= 0 ? 1 : -1;
    const pose = computeHeadPose(pts, width, height) || {};
    const owner = (persons && persons.length)
      ? ownerOf(persons, tip.x * width, tip.y * height) : null;
    out.push({
      x: tip.x, y: tip.y,
      span,
      yawDeg: finite(pose.yawAbs) ? pose.yawAbs : NaN,
      pitchDeg: finite(pose.pitchAbs) ? pose.pitchAbs : NaN,
      rollDeg: finite(pose.rollAbs) ? pose.rollAbs : NaN,
      shift,
      dirx: ux * sgn,
      diry: uy * sgn,
      objects: (owner && owner.nearby) || {},
    });
  }
  return out;
}

/** Every object the frame saw, owned or not, best confidence per name - the room's own inventory. */
export function roomObjects(boxes) {
  const room = {};
  const take = (list) => {
    for (const o of list || []) {
      if (!o || !o.name || !finite(o.conf)) continue;
      if (!(o.conf > (room[o.name] || 0))) continue;
      room[o.name] = o.conf;
    }
  };
  if (boxes) {
    take(boxes.orphans);
    for (const p of boxes.persons || []) take(Object.keys(p.nearby || {})
      .map((name) => ({ name, conf: p.nearby[name] })));
  }
  return room;
}

const hasObject = (map, names, T) => names
  .filter((n) => map && finite(map[n]) && map[n] >= T.OBJ_CONF)
  .sort((a, b) => map[b] - map[a]);

const isForward = (h, T) => Math.abs(h.yawDeg) <= T.FORWARD_YAW_DEG
  && Math.abs(h.pitchDeg) <= T.FORWARD_PITCH_DEG;

const isDown = (h, T) => finite(h.pitchDeg) && h.pitchDeg > T.DOWN_PITCH_DEG;

/** Turned enough to have a direction at all. */
const hasDir = (h, T) => Math.abs(h.shift) >= T.TURN_SHIFT;

/** cos between where a points and the line a-b, or null when a is not turned toward b's side. */
function aimCos(a, b, T) {
  if (!hasDir(a, T)) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return null;
  return (a.dirx * dx + a.diry * dy) / len;
}

/** True when a is pointing at b and they are close enough to be at one table. */
function aimsAt(a, b, T) {
  const c = aimCos(a, b, T);
  if (c === null || c < T.AIM_COS) return null;
  if (Math.hypot(b.x - a.x, b.y - a.y) > T.CLUSTER_SPAN) return null;
  return c;
}

const f2 = (v) => (finite(v) ? v.toFixed(2) : '--');
const deg = (v) => (finite(v) ? Math.round(v) + '°' : '--');
const pct = (v) => (finite(v) ? Math.round(v * 100) + '%' : '--');

/**
 * One frame's worth of rules. Pure: same signals in, same label and same sentence out, no clock.
 *
 * Order is the argument. The social labels are tried before the object labels because a group of three
 * children leaning in over one laptop is a discussion, not a practice session - the device is the
 * weaker evidence of what is happening. BREAK is tried first among the positive labels because it is
 * the only one that reads the *absence* of the class as evidence, and the fall-through to
 * INDIVIDUAL_STUDY is last because it is what a room does when nothing else fired.
 *
 * @param {object} sig  { heads, persons, room, goneMs }
 * @param {object} T    threshold table, CONTEXT_T by default
 * @returns {{context:number|null, evidence:string}} context is null for the one case that carries no
 *   information: person boxes in shot, no face yet, and the gap still shorter than the phone's own
 *   break threshold. That is a frame to skip, not a label to print.
 */
export function classify(sig, T = CONTEXT_T) {
  const heads = (sig && sig.heads) || [];
  const room = (sig && sig.room) || {};
  const persons = (sig && sig.persons) || 0;
  const goneMs = (sig && sig.goneMs) || 0;
  const n = heads.length;
  const fwd = heads.filter((h) => isForward(h, T)).length;
  const down = heads.filter((h) => isDown(h, T)).length;
  const breakSeen = hasObject(room, BREAK_OBJECTS, T);
  const practiceSeen = hasObject(room, PRACTICE_OBJECTS, T);
  const bookSeen = hasObject(room, READING_OBJECTS, T);

  // Directed aims between heads, kept with their numbers because the evidence has to show them.
  const links = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const c = aimsAt(heads[i], heads[j], T);
      if (c !== null) links.push({ i, j, cos: c });
    }
  }
  const aimedHeads = new Set(links.map((l) => l.i));

  if (n === 0) {
    if (!persons) {
      return { context: ClassContext.UNKNOWN, evidence: 'không thấy ai trước camera' };
    }
    // The phone's own definition of a real gap: a face missing longer than BREAK_DETECT_MS is a break,
    // shorter than that is a child who leaned back or a mesh the model missed for a second.
    if (goneMs >= BREAK_DETECT_MS) {
      return { context: ClassContext.BREAK,
        evidence: 'mặt vắng ' + (goneMs / 1000).toFixed(0) + ' s (ngưỡng '
          + (BREAK_DETECT_MS / 1000).toFixed(0) + ' s), còn ' + persons + ' hộp người'
          + (breakSeen.length ? ' + ' + breakSeen.slice(0, 2).join(',') : '')
          + ' - dấu hiệu nghỉ, không phải dấu hiệu mất tập trung' };
    }
    // null is not a label and the engine must not treat it as one: a short gap says nothing, so the
    // activity that was already on screen stays on screen. This is the same principle the numbers
    // column uses for an empty chair - "no face is missing data, not inattention" - applied to the room.
    return { context: null,
      evidence: persons + ' hộp người nhưng chưa có mặt nào trong '
        + (goneMs / 1000).toFixed(1) + ' s' };
  }

  // 1. BREAK with the class still in shot: nobody faces the lens and the desk holds break things.
  //    Requiring both is what keeps a turned-away child during work out of this label.
  if (fwd === 0 && breakSeen.length) {
    return { context: ClassContext.BREAK,
      evidence: n + ' đầu, không đầu nào hướng ống kính · đồ nghỉ: '
        + breakSeen.slice(0, 3).map((o) => o + ' ' + pct(room[o])).join(', ') };
  }

  // 2. PAIR_WORK: exactly two heads, each pointing at the other. Both directions must agree, so one
  //    child glancing sideways at a neighbour stays what it is - a turned head, not a pair.
  if (n === 2) {
    const ab = aimsAt(heads[0], heads[1], T), ba = aimsAt(heads[1], heads[0], T);
    if (ab && ba) {
      return { context: ClassContext.PAIR_WORK,
        evidence: '2 đầu quay vào nhau (cos ' + f2(ab) + ' / ' + f2(ba)
          + ', cách ' + f2(Math.hypot(heads[1].x - heads[0].x, heads[1].y - heads[0].y)) + ' khung)' };
    }
  }

  // 3. PRESENTATION: the biggest face in the frame faces the lens while the rest of the room points at
  //    it. "Biggest" is the only stand-up proxy this camera has - eye span grows as the head comes
  //    closer, so a child at the front of the class is a wider mesh than the rows behind.
  if (n >= 2) {
    let presenter = 0;
    for (let i = 1; i < n; i++) if (heads[i].span > heads[presenter].span) presenter = i;
    const others = heads.filter((h, i) => i !== presenter);
    const aimed = links.filter((l) => l.i !== presenter && l.j === presenter);
    const otherSpan = others.reduce((m, h) => Math.max(m, h.span), 0);
    if (isForward(heads[presenter], T) && heads[presenter].span >= T.PRESENTER_SPAN * otherSpan
      && aimed.length && aimed.length >= Math.ceil(others.length / 2)) {
      return { context: ClassContext.PRESENTATION,
        evidence: 'đầu ' + (presenter + 1) + ' gần nhất (mắt ' + f2(heads[presenter].span) + ' so với '
          + f2(otherSpan) + ' ≥ ' + T.PRESENTER_SPAN + '×), hướng ống kính · '
          + aimed.length + '/' + others.length + ' đầu còn lại quay về phía em đó' };
    }
  }

  // 4. GROUP_DISCUSSION: at least three heads and at least two of them aimed at somebody else.
  //    Two links, not one, because a single pointed head inside a group of three is the pair case
  //    wearing a bigger cast.
  if (n >= 3 && aimedHeads.size >= 2) {
    return { context: ClassContext.GROUP_DISCUSSION,
      evidence: n + ' đầu, ' + aimedHeads.size + ' đầu quay sang bạn gần (link ' + links.length
        + ', cos ' + f2(Math.max(...links.map((l) => l.cos))) + ')' };
  }

  // 5. PRACTICE: a device in reach of somebody who is facing it.
  if (practiceSeen.length && (fwd > 0 || down > 0)) {
    const owner = heads.find((h) => hasObject(h.objects, PRACTICE_OBJECTS, T).length);
    return { context: ClassContext.PRACTICE,
      evidence: 'thiết bị trong tầm: ' + practiceSeen.slice(0, 3)
        .map((o) => o + ' ' + pct(room[o])).join(', ')
        + (owner ? ' · thuộc đầu ' + (heads.indexOf(owner) + 1) : ' · không thuộc ai')
        + ' · ' + fwd + '/' + n + ' đầu hướng lên trên' };
  }

  // 6. READING-or-writing: a head bent past the floor with a book in the room, or most of the room bent
  //    with nothing else to read. The pen is invisible to this detector, so the label says both.
  if (down > 0 && (bookSeen.length || down === n)) {
    return { context: ClassContext.READING,
      evidence: down + '/' + n + ' đầu cúi quá ' + T.DOWN_PITCH_DEG + '° ('
        + heads.filter((h) => isDown(h, T)).map((h) => deg(h.pitchDeg)).join(', ') + ')'
        + (bookSeen.length ? ' · có sách ' + pct(room.book) : ' · không có thiết bị nào khác') };
  }

  // 7. The fall-through: somebody is facing the lens and nothing social fired.
  if (fwd > 0) {
    return { context: ClassContext.INDIVIDUAL_STUDY,
      evidence: fwd + '/' + n + ' đầu hướng ống kính, không đầu nào quay sang bạn '
        + '(link ' + links.length + ')' };
  }

  return { context: ClassContext.UNKNOWN,
    evidence: n + ' đầu, ' + down + ' cúi, ' + links.length + ' quay sang bạn, '
      + 'không đủ dấu hiệu cho hoạt động nào' };
}

/**
 * The engine: one classify() per sample, plus the hold that stops the label flickering.
 *
 * A child turning his head for two seconds must not rename the lesson, so a new label only lands after
 * it has been proposed continuously for HOLD_MS - the same shape as SituationEngine's switch hold,
 * paced for a slower quantity. While the hold is running the column keeps the old label and says which
 * label the current frame is arguing for, because a hidden disagreement is how an operator loses trust
 * in a label they cannot check.
 */
export class ClassContextEngine {
  constructor(t = CONTEXT_T) {
    this.T = Object.assign({}, CONTEXT_T, t || {});
    this.reset();
  }

  reset() {
    this.context = ClassContext.UNKNOWN;
    this.raw = ClassContext.UNKNOWN;
    this.evidence = 'chưa có khung nào';
    this.candidate = ClassContext.UNKNOWN;
    this.candidateAtMs = 0;
    this.sinceMs = 0;
    this.switches = 0;
    this.samples = 0;
    this.emptySinceMs = 0;
  }

  /**
   * @param {object} sig  { heads, persons, room } from headSignals/roomObjects
   * @param {number} nowMs performance.now() of the frame those landmarks came from
   */
  update(sig, nowMs) {
    const heads = (sig && sig.heads) || [];
    if (!heads.length) {
      if (!this.emptySinceMs) this.emptySinceMs = nowMs;
    } else {
      this.emptySinceMs = 0;
    }
    const s = Object.assign({}, sig, { heads, goneMs: this.emptySinceMs ? nowMs - this.emptySinceMs : 0 });
    const r = classify(s, this.T);
    this.samples++;
    this.raw = r.context;
    this.rawEvidence = r.evidence;
    if (r.context === null) {
      // A frame with no face and no gap long enough to be a break has no vote. It must neither start a
      // proposal nor advance one, or two seconds of dropped mesh would be held against the label.
      this.candidate = this.context;
      this.candidateAtMs = 0;
      return this.snapshot(nowMs);
    }
    if (r.context === this.context) {
      this.candidate = r.context;
      this.candidateAtMs = 0;
    } else if (this.context === ClassContext.UNKNOWN && r.context !== ClassContext.UNKNOWN) {
      // Nobody is arguing with a label the column has never printed, so the first real one lands at
      // once - the same exception SituationEngine makes when it steps out of UNKNOWN.
      this.context = r.context;
      this.candidate = r.context;
      this.candidateAtMs = 0;
      this.sinceMs = nowMs;
    } else if (r.context !== this.candidate) {
      this.candidate = r.context;
      this.candidateAtMs = nowMs;
    } else if (nowMs - this.candidateAtMs >= this.T.HOLD_MS) {
      this.context = r.context;
      this.candidateAtMs = 0;
      this.sinceMs = nowMs;
      this.switches++;
    }
    return this.snapshot(nowMs);
  }

  snapshot(nowMs) {
    const label = CLASS_CONTEXT_VI[this.context];
    let evidence = this.rawEvidence;
    // While a switch is pending, show both facts instead of pretending the frame agrees with the label.
    if (this.raw === null) {
      evidence = 'khung này không có mặt nào để đọc (' + this.rawEvidence + ') · giữ nhãn trước';
    } else if (this.raw !== this.context) {
      const held = this.sinceMs ? ((nowMs - this.sinceMs) / 1000).toFixed(0) + ' s' : '--';
      evidence = label + ' (giữ ' + held + '), khung này nghiêng về "'
        + CLASS_CONTEXT_VI[this.raw] + '": ' + this.rawEvidence;
    }
    return {
      context: this.context,
      raw: this.raw,
      label,
      evidence,
      switches: this.switches,
      samples: this.samples,
      heldMs: this.sinceMs ? nowMs - this.sinceMs : 0,
    };
  }
}
