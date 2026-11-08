// Scratch test for the object whitelist - Node only, no browser, no camera.
// The point is the seam between two files that must never drift apart: js/yolo.mjs names objects by
// COCO row number, js/detect.mjs names them by the string MediaPipe hands back, and a wrong row still
// draws a confident box - it just says "cốc nước" over a chai nước.
import { YOLO_CLASSES, decodeYolo, letterboxPlan } from
  '../dist/js/yolo.mjs';
import { CONTEXT_VI, readBoxes, assignObjects, phoneContextPenalty, vi, DETECT_CONF } from
  '../dist/js/detect.mjs';

// The label order read out of the shipped efficientdet_lite0.tflite itself (all 80 names present), so
// this table is the model's word, not mine.
const COCO = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse',
  'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie',
  'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
  'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon',
  'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut',
  'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book',
  'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'];

let fails = 0;
const check = (name, got, want) => {
  const ok = want instanceof RegExp ? want.test(got) : typeof want === 'function' ? want(got)
    : got === want;
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(got));
};

check('the table is the real COCO order', COCO.length, 80);
check('table sanity: person 0', COCO[0], 'person');
check('table sanity: cell phone 67', COCO[67], 'cell phone');

for (const [id, name] of YOLO_CLASSES) check('yolo id ' + id + ' spells ' + name, COCO[id], name);
check('no repeated id', YOLO_CLASSES.map((c) => c[0]).length,
  new Set(YOLO_CLASSES.map((c) => c[0])).size);
check('no repeated name', YOLO_CLASSES.map((c) => c[1]).length,
  new Set(YOLO_CLASSES.map((c) => c[1])).size);

// Every object the YOLO path can emit must have a Vietnamese name and must survive readBoxes.
const fold = (n) => (n === 'cell phone' ? 'phone' : n);
for (const [, name] of YOLO_CLASSES) {
  if (name === 'person') continue;
  check('CONTEXT_VI knows ' + name, typeof CONTEXT_VI[fold(name)], 'string');
}
check('one person row plus every object row', YOLO_CLASSES.length, Object.keys(CONTEXT_VI).length + 1);

const det = (name, x0, y0, w, h, conf = 0.6) => ({
  boundingBox: { originX: x0, originY: y0, width: w, height: h },
  categories: [{ categoryName: name, score: conf }],
});

let r = readBoxes({ detections: [det('person', 0, 0, 200, 300), det('bottle', 60, 200, 20, 40),
  det('cup', 120, 210, 22, 20), det('chair', 300, 100, 90, 160), det('cell phone', 70, 190, 30, 50)] });
check('persons split from objects', [r.persons.length, r.objects.length], ([p, o]) => p === 1 && o === 3);
check('chair is furniture, not an object', r.objects.some((o) => o.name === 'chair'), false);
check('cell phone folds to the shared name', r.objects.some((o) => o.name === 'phone'), true);
check('bottle reaches the overlay', r.objects.some((o) => o.name === 'bottle'), true);
check('plate word for a bottle', vi('bottle'), 'chai nước');
check('plate word for a cell phone', vi('cell phone'), 'điện thoại');
check('unknown names keep their own spelling', vi('giraffe'), 'giraffe');
check('empty detector answer stays empty',
  readBoxes(null), (x) => x.persons.length === 0 && x.objects.length === 0);

// Ownership: the bottle belongs to the student whose box holds its centre, and only the smallest such box.
const two = readBoxes({ detections: [det('person', 0, 0, 200, 300), det('person', 40, 0, 100, 300),
  det('bottle', 78, 150, 10, 20)] });
const orphans = assignObjects(two.persons, two.objects);
check('the tighter box owns the bottle', two.persons[1].nearby.bottle, 0.6);
check('the wider box does not also claim it', two.persons[0].nearby.bottle, undefined);
check('nothing left unowned', orphans.length, 0);
const floor = readBoxes({ detections: [det('bottle', 500, 500, 10, 10)] });
check('a bottle on nobody\'s desk is an orphan', assignObjects(floor.persons, floor.objects).length, 1);

// The reason the list could not simply become eighty classes: only 'phone' is allowed to move a score.
check('a bottle costs no SEI', phoneContextPenalty({ bottle: 0.9 }, 25, 0), 0);
check('a book costs no SEI', phoneContextPenalty({ book: 0.9 }, 25, 0), 0);
check('a phone still costs SEI', phoneContextPenalty({ phone: 0.9 }, 25, 0), 25);
check('a phone flat on the desk still does not', phoneContextPenalty({ phone: 0.9 }, 5, 0), 0);

// End-to-end through the real decoder: plant a bottle row and check the box lands in frame pixels.
const S = 8400;
const out = new Float32Array(84 * S);
// One winner per anchor: decodeYolo takes the highest-scoring row at each anchor, so two classes
// planted on the same i is a test bug, not model behaviour - every box needs its own slot.
const plant = (i, cls, cx, cy, bw, bh, score) => {
  out[i] = cx; out[S + i] = cy; out[2 * S + i] = bw; out[3 * S + i] = bh;
  out[(4 + cls) * S + i] = score;
};
plant(4200, 39, 320, 240, 40, 80, 0.8);   // bottle, dead centre of the letterbox
plant(4201, 0, 160, 240, 120, 300, 0.9);  // person
const plan = letterboxPlan(640, 480);
const dec = decodeYolo(out, plan, 640, 480, DETECT_CONF, 32);
check('decoder emits both rows', dec.detections.length, 2);
const b = dec.detections.find((d) => d.categories[0].categoryName === 'bottle');
check('bottle decodes near the centre', !!b && Math.abs(b.boundingBox.originX - 300) < 6, true);
check('bottle survives readBoxes after a real decode',
  readBoxes(dec).objects.map((o) => o.name), (v) => v.length === 1 && v[0] === 'bottle');

// The cap is the part of widening the list that could move a SCORE rather than a label: yolo.mjs slices
// the top maxResults AFTER per-class NMS, so a lunchbox frame competes with the one name
// phoneContextPenalty() reads. Here 40 objects outrank a phone sitting at 0.36, just over the bar.
const many = new Float32Array(84 * S);
const plantAt = (buf, i, cls, score) => {
  buf[i] = 100 + (i % 400); buf[S + i] = 100 + (i % 300);
  buf[2 * S + i] = 40; buf[3 * S + i] = 40;
  buf[(4 + cls) * S + i] = score;
};
let slot = 100;
for (const [id] of YOLO_CLASSES) {
  if (id !== 67) plantAt(many, slot++, id, 0.9);
}
plantAt(many, 4000, 67, 0.36);   // the weakest box in the frame is the one that matters
const wide = decodeYolo(many, letterboxPlan(640, 480), 640, 480, DETECT_CONF);
check('every allowed class reaches the overlay', wide.detections.length, YOLO_CLASSES.length);
check('a phone at the bottom of a busy frame is not truncated away',
  wide.detections.some((d) => d.categories[0].categoryName === 'cell phone'), true);
check('the same frame at the old cap of 32 would have dropped it',
  decodeYolo(many, letterboxPlan(640, 480), 640, 480, DETECT_CONF, 32).detections
    .some((d) => d.categories[0].categoryName === 'cell phone'), false);
check('the busy frame still hands the phone to the name the score rule reads',
  readBoxes(wide).objects.some((o) => o.name === 'phone'), true);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall object checks passed');
process.exit(fails ? 1 : 0);
