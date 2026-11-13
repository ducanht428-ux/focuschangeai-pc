// Node-only suite for the rule-based Classroom Context Engine - no browser, no camera, no model.
//
// Three families of checks, and each exists for a different reason.
//   1. classify() over hand-written head records, one per activity, plus the falsification next to it:
//      a rule that only ever fires is worthless, so every positive case is paired with the frame that
//      looks similar and must NOT produce the same label.
//   2. headSignals() over synthetic meshes built from a rigid head model, because the aim test rests on
//      one claim: that the nose offset in the image points the way the face points. If that sign is
//      wrong, every social label is inverted and no amount of rule testing would notice.
//   3. The hold timer, and the two HUD rows the page prints - including the sentence that says these
//      are hand-written rules with no measured accuracy, which must not be editable away.
//
// Nothing here quotes a real-face accuracy number, because none has been measured.
import {
  BREAK_OBJECTS, CLASS_CONTEXT_VI, ClassContext, ClassContextEngine, CONTEXT_T, PRACTICE_OBJECTS,
  READING_OBJECTS, classify, headSignals, roomObjects,
} from 'file:///C:/Users/Admin/Documents/Qoder/2026-10-21/4a36d25f/pc-app/dist/js/context.mjs';
import { hudLines } from 'file:///C:/Users/Admin/Documents/Qoder/2026-10-21/4a36d25f/pc-app/dist/js/hud.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = want instanceof RegExp ? want.test(got) : typeof want === 'function' ? want(got)
    : got === want;
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(
    typeof got === 'string' ? got.slice(0, 120) : got));
};
const near = (v, want, tol) => finiteCheck(v, want, tol);
const finiteCheck = (v, want, tol) => typeof v === 'number' && Number.isFinite(v)
  && Math.abs(v - want) <= tol;

// ---------------------------------------------------------------------------
// 1. The seven labels, from hand-written geometry.
// A head record is exactly what headSignals produces; writing them by hand keeps each rule's trigger
// visible instead of buried in a mesh that would need a comment to say what it means.
const head = (x, y, o = {}) => Object.assign({
  x, y, span: 0.14, yawDeg: 0, pitchDeg: 0, rollDeg: 0,
  shift: 0, dirx: 1, diry: 0, objects: {},
}, o);
const sig = (heads, extra = {}) => Object.assign({ heads, persons: heads.length, room: {} }, extra);
const label = (s, T = CONTEXT_T) => classify(s, T).context;
const why = (s, T = CONTEXT_T) => classify(s, T).evidence;

// --- individual study: one child facing the lens, nothing else in the room.
const oneForward = sig([head(0.5, 0.5)]);
check('một em hướng ống kính -> học cá nhân', label(oneForward), ClassContext.INDIVIDUAL_STUDY);
check('dấu hiệu nêu số đầu và số link', why(oneForward), /1\/1 đầu hướng ống kính.*link 0/);

// --- reading or writing: the same child bent over the desk.
const oneDown = sig([head(0.5, 0.5, { pitchDeg: 34 })]);
check('cúi đầu + sách -> đọc hoặc viết',
  label(sig([head(0.5, 0.5, { pitchDeg: 34 })], { room: { book: 0.61 } })), ClassContext.READING);
check('cúi đầu, không có gì khác -> vẫn đọc hoặc viết', label(oneDown), ClassContext.READING);
check('bút và vở không tồn tại nên nhãn nói cả viết',
  CLASS_CONTEXT_VI[ClassContext.READING], /đọc hoặc viết/);
check('falsification: cúi nhẹ dưới ngưỡng không thành đọc',
  label(sig([head(0.5, 0.5, { pitchDeg: CONTEXT_T.DOWN_PITCH_DEG - 1 })])),
  ClassContext.INDIVIDUAL_STUDY);

// --- practice: a device in reach of a head that faces it.
const laptop = { laptop: 0.72 };
check('laptop trong tầm -> thực hành',
  label(sig([head(0.5, 0.5, { objects: laptop })], { room: laptop })), ClassContext.PRACTICE);
check('dấu hiệu thực hành kể tên thiết bị',
  why(sig([head(0.5, 0.5, { objects: laptop })], { room: laptop })), /laptop 72%/);
check('falsification: laptop 0.30 dưới ngưỡng tin cậy -> học cá nhân',
  label(sig([head(0.5, 0.5, { objects: { laptop: 0.3 } })], { room: { laptop: 0.3 } })),
  ClassContext.INDIVIDUAL_STUDY);
check('ngưỡng vật chung với cửa phạt điện thoại', CONTEXT_T.OBJ_CONF, 0.4);

// --- pair work: two heads, each turned at the other.
const pair = sig([
  head(0.35, 0.5, { shift: 0.21, dirx: 1 }),
  head(0.62, 0.5, { shift: -0.19, dirx: -1 }),
]);
check('hai đầu quay vào nhau -> làm việc cặp', label(pair), ClassContext.PAIR_WORK);
check('dấu hiệu cặp có cosine của cả hai chiều', why(pair), /cos 1\.00 \/ 1\.00, cách 0\.27 khung/);
check('falsification: một đầu quay, một đầu thẳng -> không phải cặp',
  label(sig([head(0.35, 0.5, { shift: 0.21, dirx: 1 }), head(0.62, 0.5)])),
  (c) => c !== ClassContext.PAIR_WORK);
check('falsification: hai đầu quay ra xa nhau -> không phải cặp',
  label(sig([
    head(0.35, 0.5, { shift: -0.21, dirx: -1 }),
    head(0.62, 0.5, { shift: 0.21, dirx: 1 }),
  ])), (c) => c !== ClassContext.PAIR_WORK);
check('falsification: cặp quá xa nhau trong khung -> không phải cặp',
  label(sig([
    head(0.05, 0.5, { shift: 0.21, dirx: 1 }),
    head(0.95, 0.5, { shift: -0.21, dirx: -1 }),
  ])), (c) => c !== ClassContext.PAIR_WORK);
check('falsification: quay rất nhẹ dưới ngưỡng hướng -> chưa đủ để gọi là cặp',
  label(sig([
    head(0.35, 0.5, { shift: CONTEXT_T.TURN_SHIFT - 0.02, dirx: 1 }),
    head(0.62, 0.5, { shift: -(CONTEXT_T.TURN_SHIFT - 0.02), dirx: -1 }),
  ])), (c) => c !== ClassContext.PAIR_WORK);

// --- presentation: the near head faces the lens, the room points at it.
const presenter = head(0.5, 0.3, { span: 0.30 });
const audience = [
  head(0.25, 0.66, { shift: 0.2, dirx: 1 }),
  head(0.75, 0.66, { shift: -0.2, dirx: -1 }),
];
check('một em gần ống kính nhất, lớp quay về phía em -> thuyết trình',
  label(sig([presenter, ...audience])), ClassContext.PRESENTATION);
check('dấu hiệu thuyết trình nói ai quay về ai',
  why(sig([presenter, ...audience])), /2\/2 đầu còn lại quay về phía em đó/);
check('falsification: người đứng không hướng ống kính -> không phải thuyết trình',
  label(sig([head(0.5, 0.3, { span: 0.30, yawDeg: 48 }), ...audience])),
  (c) => c !== ClassContext.PRESENTATION);
check('falsification: hai đứa ngồi cạnh đứa thứ ba -> chưa đủ gần để thành thuyết trình',
  label(sig([head(0.5, 0.3, { span: 0.15, objects: {} }), ...audience])),
  (c) => c !== ClassContext.PRESENTATION);
check('ngưỡng gần hơn của người thuyết trình là 1.5×', CONTEXT_T.PRESENTER_SPAN, 1.5);

// --- group discussion: three or more, several of them aimed at somebody.
const group = [
  head(0.2, 0.5, { shift: 0.2, dirx: 1 }),
  head(0.34, 0.52, { shift: -0.2, dirx: -1 }),
  head(0.3, 0.62, { shift: 0.2, dirx: 1 }),
];
check('bốn? không - ba đầu quay vào nhau -> thảo luận nhóm', label(sig(group)),
  ClassContext.GROUP_DISCUSSION);
check('falsification: ba đầu thẳng hàng, không ai quay -> học cá nhân',
  label(sig([head(0.2, 0.5), head(0.4, 0.5), head(0.6, 0.5)])), ClassContext.INDIVIDUAL_STUDY);
// Deliberate, and worth naming: PAIR_WORK asks for exactly two heads, so two children turning to each
// other inside a group of three are reported as a group. The label describes the room, not the pair.
check('ba đầu, hai đứa quay vào nhau -> nhóm thắng vì cặp chỉ nhận đúng hai đầu',
  label(sig([head(0.35, 0.5, { shift: 0.21, dirx: 1 }), head(0.62, 0.5, { shift: -0.21, dirx: -1 }),
    head(0.9, 0.5)])), ClassContext.GROUP_DISCUSSION);
check('falsification: một đầu quay giữa ba đầu -> chưa đủ liên kết',
  label(sig([head(0.2, 0.5, { shift: 0.2, dirx: 1 }), head(0.34, 0.52), head(0.5, 0.5)])),
  (c) => c !== ClassContext.GROUP_DISCUSSION);

// --- break: nobody faces the lens and the desk holds break things.
const away = [head(0.3, 0.5, { yawDeg: 62, shift: -0.3, dirx: -1 }),
  head(0.6, 0.5, { yawDeg: 70, shift: 0.3, dirx: 1 })];
const breakRoom = { cup: 0.77, banana: 0.55, backpack: 0.6 };
check('không đầu nào hướng lên + đồ ăn -> nghỉ giải lao',
  label(sig(away, { room: breakRoom })), ClassContext.BREAK);
check('dấu hiệu nghỉ kể đúng đồ nhìn thấy',
  why(sig(away, { room: breakRoom })), /cup 77%.*banana 55%/);
check('falsification: không đầu nào hướng lên, không có đồ -> chưa rõ',
  label(sig(away)), ClassContext.UNKNOWN);
check('falsification: một em vẫn hướng ống kính giữa lúc có bim trên bàn -> chưa nghỉ',
  label(sig([head(0.3, 0.5), away[1]], { room: breakRoom })),
  (c) => c !== ClassContext.BREAK);

// --- nobody in shot: the phone's own gap rule decides break versus nothing-to-say.
const noFaces = (goneMs, persons = 2) => sig([], { persons, goneMs });
check('mặt vắng quá ngưỡng của điện thoại -> nghỉ giải lao',
  label(noFaces(25000)), ClassContext.BREAK);
check('ngưỡng vắng mặt lấy đúng từ params', why(noFaces(25000)), /ngưỡng 20 s/);
// null, not UNKNOWN: a person box whose mesh dropped for two seconds is missing data, and a frame with
// no information must not rename the room. The engine's side of this seam is tested in section 3.
check('falsification: vắng 5 s -> không có phiếu (null), không phải nghỉ',
  label(noFaces(5000)), null);
check('falsification: vắng 5 s vẫn nói rõ vì sao không có phiếu',
  why(noFaces(5000)), /2 hộp người nhưng chưa có mặt nào trong 5\.0 s/);
check('falsification: không người không mặt -> chưa rõ',
  label(noFaces(40000, 0)), ClassContext.UNKNOWN);
check('khung rỗng hoàn toàn không làm crash', classify(null).context, ClassContext.UNKNOWN);

// ---------------------------------------------------------------------------
// 2. The geometry layer, on meshes built from one rigid head.
const RAD = Math.PI / 180;
/**
 * One rigid head, placed in PIXELS and then normalised the way MediaPipe hands landmarks back.
 *
 * The order matters and was learned the hard way on the first run of this suite: computeHeadPose
 * multiplies x and z by the frame width but y by the frame height, so a model written directly in
 * normalised units hands that function two vectors that are orthogonal in pixels and skewed in the
 * mixed space - a 25° pitch alone came back as 23° of yaw. Built in pixels, the cross product it takes
 * is the head's real face normal and the angles it prints are the angles asked for.
 */
function mesh(o = {}) {
  const { cx = 0.5, cy = 0.5, span = 0.22, yaw = 0, pitch = 0 } = o;
  const a = yaw * RAD, b = pitch * RAD;
  const X = { x: Math.cos(a), y: 0, z: Math.sin(a) };           // 234 -> 454
  const Y = { x: 0, y: -Math.cos(b), z: -Math.sin(b) };         // chin -> forehead, tipped by pitch
  const Z = { x: Math.sin(a), y: Math.cos(a) * Math.sin(b), z: -Math.cos(a) * Math.cos(b) };
  const unit = span * 640 / 2;                                  // one unit = half the eye span, pixels
  const at = (vx, vy, vz) => ({
    x: (cx * 640 + (X.x * vx + Y.x * vy + Z.x * vz) * unit) / 640,
    y: (cy * 480 + (X.y * vx + Y.y * vy + Z.y * vz) * unit) / 480,
    z: (X.z * vx + Y.z * vy + Z.z * vz) * unit / 640,
  });
  const pts = Array.from({ length: 478 }, () => at(0, 0, 0));
  const eA = at(-1, 0, 0), eB = at(1, 0, 0);
  for (const i of [33, 160, 158, 133, 153, 144]) pts[i] = eA;
  for (const i of [362, 385, 387, 263, 373, 380]) pts[i] = eB;
  pts[1] = at(0, -0.05, 0.54);                                  // the nose sits out along the normal
  pts[10] = at(0, 1.2, 0);
  pts[152] = at(0, -1.2, 0);
  pts[234] = at(-1.3, 0, 0);
  pts[454] = at(1.3, 0, 0);
  return pts;
}
const box = (x0, y0, x1, y1, nearby = {}) => ({ x0, y0, x1, y1, conf: 0.8, id: 1, nearby });

const flat = headSignals([mesh()], 640, 480, [])[0];
check('mesh thẳng: có một đầu', !!flat, true);
check('mesh thẳng: yaw ~ 0', near(flat.yawDeg, 0, 1), true);
check('mesh thẳng: pitch ~ 0', near(flat.pitchDeg, 0, 1), true);
check('mesh thẳng: không có hướng quay', Math.abs(flat.shift) < CONTEXT_T.TURN_SHIFT, true);
check('mesh thẳng: span đúng bằng khoảng mắt', near(flat.span, 0.22, 0.001), true);

const turned = headSignals([mesh({ yaw: 30 })], 640, 480, [])[0];
check('quay 30 độ: yaw đo lại ~ 30', near(turned.yawDeg, 30, 2), true);
check('quay 30 độ: mũi lệch dương về phía +x', turned.shift > CONTEXT_T.TURN_SHIFT, true);
check('QUY TẮC AIM: đầu quay +x có dirx = +1', turned.dirx > 0.9, true);
check('QUY TẮC AIM: đầu quay -x có dirx = -1',
  headSignals([mesh({ yaw: -30 })], 640, 480, [])[0].dirx < -0.9, true);

const bent = headSignals([mesh({ pitch: 25 })], 640, 480, [])[0];
check('cúi 25 độ: pitch đo lại ~ 25', near(bent.pitchDeg, 25, 2), true);
check('cúi không tạo ra hướng quay giả', Math.abs(bent.shift) < CONTEXT_T.TURN_SHIFT, true);

const owners = headSignals([mesh({ cx: 0.3 }), mesh({ cx: 0.7 })], 640, 480,
  [box(0, 0, 320, 480, { laptop: 0.7 }), box(320, 0, 640, 480, { book: 0.66 })]);
check('hai đầu ra đủ hai bản ghi', owners.length, 2);
check('vật thuộc đúng hộp chứa mũi em đó',
  owners[0].objects.laptop > 0.6 && !owners[0].objects.book, true);
check('đầu bên phải nhận quyển sách',
  owners[1].objects.book > 0.6 && !owners[1].objects.laptop, true);
check('falsification: không có hộp người thì đầu không nhận vật nào',
  Object.keys(headSignals([mesh()], 640, 480, [])[0].objects).length, 0);
check('mesh quá nhỏ bị bỏ (span dưới 0.02)',
  headSignals([mesh({ span: 0.01 })], 640, 480, []).length, 0);
// The floor is the largest eye-ring index (LEFT_EYE[3] = 263), which sits below the landmarks
// computeHeadPose reads (234 and 454). A shorter mesh than that would throw inside the pose maths, so
// headSignals must drop it first - this check is what pins the guard's real purpose.
check('mesh cụt (dưới 264 điểm) bị bỏ, không ném lỗi',
  headSignals([Array.from({ length: 263 }, () => ({ x: 0.5, y: 0.5, z: 0 }))], 640, 480, []).length, 0);

// The same pair, but built from meshes rather than typed numbers: if the aim claim above is wrong, this
// is the check that goes red, because a real left-turn / real right-turn pair must read as PAIR_WORK.
const pairMeshes = headSignals([mesh({ cx: 0.36, yaw: 24 }), mesh({ cx: 0.62, yaw: -24 })],
  640, 480, []);
check('cặp thật từ mesh -> làm việc cặp',
  classify(sig(pairMeshes)).context, ClassContext.PAIR_WORK);
const crossed = headSignals([mesh({ cx: 0.36, yaw: -24 }), mesh({ cx: 0.62, yaw: 24 })], 640, 480, []);
check('falsification: hai đầu quay NGƯỢC nhau từ mesh -> không phải cặp',
  classify(sig(crossed)).context !== ClassContext.PAIR_WORK, true);

// roomObjects: the inventory the break and practice rules read.
const rooms = roomObjects({ persons: [box(0, 0, 10, 10, { cup: 0.5 })],
  orphans: [{ name: 'cup', conf: 0.81 }, { name: 'book', conf: 0.44 }] });
check('roomObjects giữ confidence cao nhất của cùng một tên', rooms.cup, 0.81);
check('roomObjects gom cả vật không thuộc ai', rooms.book > 0.4, true);
check('roomObjects(null) là bản đồ rỗng', Object.keys(roomObjects(null)).length, 0);
check('thực hành là thiết bị, không phải đồ ăn',
  PRACTICE_OBJECTS.includes('laptop') && !PRACTICE_OBJECTS.includes('apple'), true);
check('đồ nghỉ bao gồm cặp sách và chai nước',
  BREAK_OBJECTS.includes('backpack') && BREAK_OBJECTS.includes('bottle'), true);
check('đọc là sách, và chỉ sách', READING_OBJECTS.join(','), 'book');

// ---------------------------------------------------------------------------
// 3. The hold: a label may not move on one frame.
const T0 = 1000;
const mk = (o = {}) => Object.assign({ SAMPLE_MS: 100 }, CONTEXT_T, o);
const single = sig([head(0.5, 0.5)]);

let eng = new ClassContextEngine(mk());
let s0 = eng.update(single, T0);
check('khung đầu tiên đã có nhãn ngay (chưa từng có nhãn nào để giữ)',
  eng.context, ClassContext.INDIVIDUAL_STUDY);
check('nhãn chưa đổi nên không đếm lượt đổi', eng.switches, 0);
s0 = eng.update(pair, T0 + 100);
check('100 ms đề xuất mới: chưa đổi nhãn', eng.context, ClassContext.INDIVIDUAL_STUDY);
check('100 ms: bằng chứng nói rõ đang giữ nhãn cũ', s0.evidence, /giữ/);
check('100 ms: bằng chứng cũng nói khung này nghiêng về đâu',
  s0.evidence.includes('làm việc cặp') && s0.evidence.includes('học cá nhân'), true);
eng.update(pair, T0 + CONTEXT_T.HOLD_MS - 1);
check('ngay trước ngưỡng giữ: vẫn chưa đổi', eng.context, ClassContext.INDIVIDUAL_STUDY);
eng.update(pair, T0 + CONTEXT_T.HOLD_MS + 100);
check('qua ngưỡng giữ thì đổi nhãn', eng.context, ClassContext.PAIR_WORK);
check('đổi nhãn được đếm đúng một lần', eng.switches, 1);
eng.update(single, T0 + CONTEXT_T.HOLD_MS + 200);
check('khung ngược về nhãn cũ phải giữ đủ thời gian trước khi đổi lại',
  eng.context, ClassContext.PAIR_WORK);
check('snapshot có đủ các trường trang cần',
  ['context', 'raw', 'label', 'evidence', 'switches', 'heldMs']
    .every((f) => Object.keys(eng.snapshot(T0 + 9000)).includes(f)), true);

// An interrupted proposal must restart the clock, not finish it.
eng = new ClassContextEngine(mk());
eng.update(single, T0);
eng.update(pair, T0 + 100);
eng.update(single, T0 + 900);      // breaks the proposal
eng.update(pair, T0 + 1000);       // restarts it here, not at T0+100
eng.update(pair, T0 + 1500);       // 500 ms short
check('đề xuất bị ngắt thì tính lại từ đầu (1500 ms chưa đủ)',
  eng.context, ClassContext.INDIVIDUAL_STUDY);
eng.update(pair, T0 + 2600);       // 1600 ms after the restart
check('đủ 1500 ms liên tục sau khi tính lại thì đổi', eng.context, ClassContext.PAIR_WORK);

// The empty-chair timer lives in the engine, because classify() has no clock.
eng = new ClassContextEngine(mk());
eng.update(single, T0);
let snap = eng.update(sig([], { persons: 2 }), T0 + 200);
check('vắng mặt 200 ms: khung này không có phiếu', eng.raw, null);
check('vắng mặt 200 ms: nhãn cũ vẫn đứng', eng.context, ClassContext.INDIVIDUAL_STUDY);
check('vắng mặt 200 ms: hàng dấu hiệu tự giải thích vì sao không đổi',
  snap.evidence, /khung này không có mặt nào để đọc .*giữ nhãn trước/);

// A dropped mesh must not spend somebody else's clock either: the proposal starts over once the face is
// back, exactly like an interrupted one, or two seconds of noise would be held against the room.
eng = new ClassContextEngine(mk());
eng.update(single, T0);
eng.update(pair, T0 + 100);                  // proposal starts here
eng.update(sig([], { persons: 2 }), T0 + 900);   // mesh drops for a moment
eng.update(pair, T0 + 1000);                 // and restarts here, not at T0+100
eng.update(pair, T0 + 2400);                 // 1400 ms later: still short
check('khung không mặt không được tính vào thời gian giữ',
  eng.context, ClassContext.INDIVIDUAL_STUDY);
eng.update(pair, T0 + 2500);                 // 1500 ms after the restart
check('nhãn đổi đúng 1500 ms sau khi mesh trở lại', eng.context, ClassContext.PAIR_WORK);

eng = new ClassContextEngine(mk());
eng.update(single, T0);
for (let t = T0 + 200; t <= T0 + 21000; t += 100) snap = eng.update(sig([], { persons: 2 }), t);
check('vắng quá ngưỡng của điện thoại: đề xuất nghỉ', eng.raw, ClassContext.BREAK);
check('nhãn vẫn còn giữ cho tới khi đủ 1500 ms', eng.context, ClassContext.INDIVIDUAL_STUDY);
for (let t = T0 + 21100; t <= T0 + 22700; t += 100) snap = eng.update(sig([], { persons: 2 }), t);
check('và đổi sau khi giữ đủ', eng.context, ClassContext.BREAK);
check('hàng dấu hiệu lúc nghỉ nêu cả số giây vắng',
  snap.evidence, /mặt vắng 2[0-9] s \(ngưỡng 20 s\)/);
eng.reset();
check('reset() trả về chưa rõ hoạt động', eng.context, ClassContext.UNKNOWN);
check('reset() xoá đồng hồ vắng mặt', eng.emptySinceMs, 0);
check('reset() xoá bằng chứng cũ', eng.evidence, 'chưa có khung nào');

// ---------------------------------------------------------------------------
// 4. What the column prints, and the wiring the page must keep.
const texts = (lines) => lines.map((l) => l.text).join('\n');
const cls = {
  context: ClassContext.GROUP_DISCUSSION, raw: ClassContext.GROUP_DISCUSSION,
  label: CLASS_CONTEXT_VI[ClassContext.GROUP_DISCUSSION],
  evidence: '3 đầu, 2 đầu quay sang bạn gần (link 2, cos 0.88)',
};
const withCls = hudLines(null, 3, 12, 30, { gazeH: 0.16, gazeV: 0.22 }, null, cls);
check('cột số liệu in nhãn hoạt động lớp', texts(withCls), /Hoạt động lớp: thảo luận nhóm/);
check('cột số liệu in cả dấu hiệu', texts(withCls), /3 đầu, 2 đầu quay sang bạn gần/);
check('CÂU THỪA NHẬN LUẬT VIẾT TAY còn trong hàng',
  texts(withCls), /luật viết tay, chưa kiểm định bằng dữ liệu có nhãn/);
const hudRows = texts(withCls).split('\n');
check('hàng hoạt động đứng ngay sau hàng tình huống',
  hudRows.findIndex((l) => l.startsWith('Tình huống:')) >= 0
    && hudRows[hudRows.findIndex((l) => l.startsWith('Tình huống:')) + 1].startsWith('Hoạt động lớp:'),
  true);
const noCls = hudLines(null, 3, 12, 30, { gazeH: 0.16, gazeV: 0.22 });
check('caller không có lớp ngữ cảnh vẫn in dấu gạch', texts(noCls), /Hoạt động lớp: --/);
check('và không thêm hàng dấu hiệu', texts(noCls).includes('luật viết tay'), false);
// One row, not two: the label row is always there (dash when the page has no context layer), and the
// frame only adds the evidence line when there is an evidence line to add.
check('số hàng cột tăng đúng một khi có dấu hiệu ngữ cảnh',
  withCls.length - noCls.length, 1);

// The page wiring, pinned as source text the way test-multiface pins its own seams.
const SRC = 'file:///C:/Users/Admin/Documents/Qoder/2026-10-21/4a36d25f/pc-app/dist/index.html';
const fs = await import('node:fs/promises');
const page = await fs.readFile(new URL(SRC), 'utf8');
check('trang nạp module ngữ cảnh', page, /from '\.\/js\/context\.mjs'/);
check('trang dựng tín hiệu từ chính meshes của khung', page,
  /headSignals\(lastFaces, cv\.width, cv\.height, boxes \? boxes\.persons : \[\]\)/);
check('trang gọi engine mỗi nhịp lấy mẫu', page,
  /if \(t - classAtMs >= CONTEXT_T\.SAMPLE_MS\)/);
check('trang đưa snapshot vào cột số liệu', page, /imgProcText\(\), classSnap\)/);
check('trang log khi nhãn đổi, không log mỗi khung', page, /Ngữ cảnh lớp: '/);
check('Dừng và reset đều xoá nhãn cũ', (page.match(/classEngine\.reset\(\)/g) || []).length, 2);
check('nhịp lấy mẫu nhỏ hơn một giây', CONTEXT_T.SAMPLE_MS < 1000, true);
check('thời gian giữ nhãn là 1.5 s', CONTEXT_T.HOLD_MS, 1500);

console.log(fails ? '\n' + fails + ' FAIL' : '\nall context checks green');
process.exit(fails ? 1 : 0);
