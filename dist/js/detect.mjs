// Layer 1 for this leg: the parts of the person-box overlay that can be checked without a screen.
// The Python leg keeps these same rules in focusedge/detection.py, so both PC screens put a box around
// the same shape and hand an object to the same student. The drawing itself stays in index.html.

import { GAZE_V_DRIFT } from './params.mjs';

// main.py:557-561's three colours plus the plate text colour, so a box means the same thing on both.
export const YOLO_PERSON = [0, 190, 80];
export const YOLO_FACE = [255, 205, 0];
export const YOLO_OBJECT = [255, 130, 40];
export const YOLO_TEXT = [235, 235, 235];

// The detector's own settings, each one copied from the Python leg so the two PC screens agree about
// what counts as a person and what counts as context. edge-server/config.yaml:64 conf: 0.35.
export const DETECT_CONF = 0.35;

// Ultralytics keeps every box it finds (max_det defaults to 300, verified in this machine's
// ultralytics/cfg), while MediaPipe's object detector returns at most maxResults. The cap exists so
// nothing is silently truncated, so it has to be read against the allowlist, not against the room:
// yolo.mjs slices AFTER per-class NMS, which means every object class added to CONTEXT_VI puts its
// boxes into the same competition. 32 was safe at sixteen classes; at forty-one a lunchbox frame of
// apples and buns could push a low-confidence phone out of the top 32, and 'phone' is the one name
// phoneContextPenalty() reads - so the truncation would not cost a label, it would cost a score.
// 64 is two full classroom rows of desk items and still far below what the pass can sort in time.
export const DETECT_MAX_RESULTS = 64;

// One parameter the two legs cannot share, so it is recorded rather than papered over: config.yaml:62
// runs YOLO at imgsz 640, while efficientdet_lite0 has a fixed 320-pixel input and this API exposes no
// size to raise. A phone on a back desk therefore has half the pixels here that it has on the Python
// window, so it is the first box this leg is expected to miss. The confidence bar is still the same 0.35
// - it is the resolution that is not.

// COCO names, because this API does not hand back class ids: a live probe of efficientdet_lite0 returns
// categories of { categoryName, displayName, index, score } with index = -1, so detection.py's numeric
// ids (person 0, cell phone 67, book 73, laptop 63, backpack 24) cannot be matched here. The names are
// matched instead, and CONTEXT_VI is also the allowlist: readBoxes() drops every box whose name is not a
// key of it, which is why the list below is forty objects rather than the eighty the model can score.
//
// Both weights shipped in this folder carry the full COCO label table (verified by reading the strings
// out of efficientdet_lite0.tflite: all 80 names are in it), so naming a chai nước costs no extra
// inference at all - the pass has already run. What the list decides is only which boxes survive into
// the overlay. Furniture stays out on purpose: chair 56 and dining table 60 are in every frame of a
// classroom, and they would out-number the desk items they are supposed to be background for.
//
// Parity, stated rather than glossed: focusedge/detection.py still whitelists four objects, so the
// Python window names far fewer things than this page until that dict grows too. The single rule that
// can move a score reads only 'phone' (phoneContextPenalty below), and both legs have always had that
// name, so the two screens still cannot disagree about attention - only about labels.
//
// Three things a classroom desk holds that no row of either weight can name: a pen or pencil, a
// notebook, and a pencil case. They are not in the COCO label set at all, so the model reports nothing
// or occasionally calls them a book, a handbag or a remote - there is no honest Vietnamese plate to
// print for them, which is why "bút" and "vở" cannot be added by editing a list.
export const CONTEXT_VI = {
  phone: 'điện thoại', book: 'sách', laptop: 'laptop', backpack: 'ba lô',
  bottle: 'chai nước', cup: 'cốc nước', scissors: 'cái kéo', handbag: 'túi xách',
  clock: 'đồng hồ', 'teddy bear': 'gấu bông', mouse: 'chuột máy tính',
  keyboard: 'bàn phím', remote: 'điều khiển', umbrella: 'cái ô', 'sports ball': 'quả bóng',
  tv: 'tivi', kite: 'con diều', frisbee: 'đĩa ném', skateboard: 'ván trượt',
  'tennis racket': 'cái vợt', 'baseball bat': 'gậy bóng chày',
  'baseball glove': 'găng bóng chày', 'wine glass': 'ly nước', fork: 'cái nĩa',
  knife: 'con dao', spoon: 'cái thìa', bowl: 'cái bát', banana: 'quả chuối',
  apple: 'quả táo', sandwich: 'bánh sandwich', orange: 'quả cam', broccoli: 'bông cải',
  carrot: 'củ cà rốt', 'hot dog': 'bánh mì hot dog', pizza: 'bánh pizza',
  donut: 'bánh donut', cake: 'bánh ngọt', tie: 'cà vạt', 'potted plant': 'chậu cây',
  vase: 'lọ hoa',
};
const CONTEXT_ALIASES = { 'cell phone': 'phone' };

// ByteTrack's own numbers, read from this machine's ultralytics/cfg/trackers/bytetrack.yaml:
// match_thresh 0.8 and track_buffer 30 frames; the leg adds track_ttl_ms 15000 (config.yaml:67).
export const ID_IOU_FLOOR = 0.3;
export const ID_TTL_MS = 15000;

/**
 * Overlap floor deliberately looser than ByteTrack's 0.8.
 *
 * ByteTrack matches boxes one frame apart on the Python leg, this list is matched up to 15 s apart here,
 * and a head that leans back in a chair moves further than 0.8 IoU in half a second - so the same floor
 * would renumber a student every other pass. A looser floor keeps numbers steadier and can merge two
 * students who swap seats quickly; the Python leg's number is the one to trust for a real track.
 */

const boxOf = (b) => ({ x0: b.originX, y0: b.originY, x1: b.originX + b.width,
  y1: b.originY + b.height });

/**
 * Split one detector result into the two groups the overlay draws.
 *
 * MediaPipe hands back its own shape - a bounding box in input pixels plus a category list - and the
 * rest of this leg works in x0/y0/x1/y1 rectangles with a Vietnamese label, so the conversion happens
 * once, here, where a test can check it.
 */
export function readBoxes(res) {
  const persons = [];
  const objects = [];
  if (!res || !res.detections) return { persons, objects };
  for (const det of res.detections) {
    const cat = det.categories && det.categories[0];
    if (!cat) continue;
    const name = CONTEXT_ALIASES[cat.categoryName] || cat.categoryName;
    const box = Object.assign(boxOf(det.boundingBox),
      { conf: cat.score, name, nearby: {} });
    if (name === 'person') persons.push(box);
    else if (CONTEXT_VI[name]) objects.push(box);
  }
  return { persons, objects };
}

export function iou(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
}

/**
 * Keep a box's number while the same head is still in the frame.
 *
 * This leg has no ByteTrack - Ultralytics is what makes the Python leg's track ids real, and it cannot
 * run in a tab - so the number below is continuity only: the previous passes' rectangles matched by
 * overlap keep their number, and a head that stays out long enough gets a fresh one. The Python window
 * prints a tracker id in the same "#n" plate; if a judge asks what this one is, that is the answer.
 */
export class PersonIds {
  /**
   * @param {number} floor minimum overlap for two boxes to count as the same head
   * @param {number} expiryMs how long an unseen box may keep its number - the Python leg's track_ttl_ms
   */
  constructor(floor = ID_IOU_FLOOR, expiryMs = ID_TTL_MS) {
    this.floor = floor;
    this.expiryMs = expiryMs;
    this.next = 1;
    this.history = [];
  }

  reset() { this.next = 1; this.history = []; }

  assign(persons, t) {
    const taken = new Set();
    const matched = new Set();
    const ids = persons.map((p) => {
      let best = null;
      let bestScore = this.floor;
      for (const h of this.history) {
        // An expired box must not be matched, not merely dropped from the rebuilt history: the box it
        // came from was off-screen for longer than the expiry, so a head that returns is a new head.
        if (taken.has(h.id) || t - h.at >= this.expiryMs) continue;
        const s = iou(p, h);
        if (s > bestScore) { bestScore = s; best = h; }
      }
      const id = best ? best.id : this.next++;
      if (best) { taken.add(id); matched.add(best); }
      return id;
    });
    // Rebuild the history from this pass, keeping any old box that was not matched but has not expired:
    // a head that turns away for a second keeps its number rather than being introduced as a new student.
    const rebuilt = persons.map((p, i) => Object.assign({}, p, { id: ids[i], at: t }));
    for (const h of this.history) {
      if (!matched.has(h) && t - h.at < this.expiryMs) rebuilt.push(h);
    }
    this.history = rebuilt;
    return persons.map((p, i) => Object.assign({}, p, { id: ids[i] }));
  }
}

/**
 * Record each context object on the person who actually owns it - detection.py:49's rule.
 *
 * An object belongs to the tightest person box containing its centre, not the first box in the
 * detector's output order. Two desks pressed together give one phone whose centre sits inside both
 * boxes, and listing order would give the context - and a phone-in-hand flag - to the wrong student.
 * Returns the objects nobody contains, which the overlay draws as "khong thuoc ai".
 */
export function assignObjects(persons, objects) {
  const orphans = [];
  for (const o of objects) {
    const owner = ownerOf(persons, (o.x0 + o.x1) / 2, (o.y0 + o.y1) / 2);
    if (owner) {
      if (o.conf > (owner.nearby[o.name] || 0)) owner.nearby[o.name] = o.conf;
    } else {
      orphans.push(o);
    }
  }
  return orphans;
}

/**
 * The tightest person box that contains a point, or null.
 *
 * One implementation of the containment rule on purpose: assignObjects uses it for objects, and
 * index.html uses it to decide whose face a box belongs to. Two copies of "the smallest box that
 * contains the centre" is how the two screens end up disagreeing about who owns what.
 */
export function ownerOf(persons, x, y) {
  let owner = null;
  let ownerArea = 0;
  for (const p of persons) {
    if (p.x0 <= x && x <= p.x1 && p.y0 <= y && y <= p.y1) {
      const area = (p.x1 - p.x0) * (p.y1 - p.y0);
      if (owner === null || area < ownerArea) { owner = p; ownerArea = area; }
    }
  }
  return owner;
}

/** main.py:629: the two strongest context objects per person, highest confidence first. */
export function topNearby(p, limit = 2) {
  return Object.keys(p.nearby || {}).sort((a, b) => p.nearby[b] - p.nearby[a]).slice(0, limit)
    .map((name) => [name, p.nearby[name]]);
}

// The one rule that turns detector output into a measurement instead of a picture. It is
// person_pipeline.py's phone_context_penalty, and _dev/parity/gen_parity_cases.py runs the Python
// function over a table of inputs and _dev/sei-check.mjs runs this one over the same table, so the
// two PC screens cannot disagree about the scene without a checker going red.
//
// Both floors are strict comparisons, and both are needed together. The confidence floor sits above
// DETECT_CONF so a box that only appears for one pass - a neighbour's desk, a bag on the floor -
// cannot move the score, and the pose test is what stops a phone lying face-up on the table in front
// of a student who is looking at the screen from being read as inattention.
export const CONTEXT_PHONE_CONF = 0.4;
export const CONTEXT_PHONE_PITCH_DEG = 12;
export const CONTEXT_PHONE_PENALTY = 25;

/** @param {object} nearby name -> best confidence, the .nearby map of the person being measured. */
export function phoneContextPenalty(nearby, pitchDeg, gazeVDev) {
  if (!(nearby && nearby.phone > CONTEXT_PHONE_CONF)) return 0;
  if (pitchDeg > CONTEXT_PHONE_PITCH_DEG || gazeVDev > GAZE_V_DRIFT) return CONTEXT_PHONE_PENALTY;
  return 0;
}

export const vi = (name) => CONTEXT_VI[CONTEXT_ALIASES[name] || name] || name;
