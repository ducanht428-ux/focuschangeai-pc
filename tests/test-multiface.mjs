// Scratch test for the multi-face WIRING in index.html - no browser, no camera.
//
// The page keeps its module scope to itself (nothing is hung on window), so the only way to run
// idTick/multiTick/pickMeasure/facePlateAt as they really are is to take the lines out of index.html
// and evaluate them with the globals they expect handed in as parameters. That is deliberate: the
// copy in this file is the shipped source, not a re-implementation, so a wiring bug found here is a
// bug found in dist/index.html.
import { readFileSync } from 'node:fs';
import { FaceMatcher, IDENTITY, faceSignature, faceGate, assignFaces } from
  '../dist/js/identity.mjs';

const DIST = '../dist';
const lines = readFileSync(DIST + '/index.html', 'utf8').split(/\r?\n/);
const START = lines.findIndex((s) => s.startsWith('function idTick(faces, t)'));
// learnTick is part of the slice, not stubbed: gating the enrolment is the change with the biggest
// effect on what the bank can ever recognise, so it has to be run rather than read.
const END = lines.findIndex((s) => s.startsWith('async function fillCameras'));
if (START < 0 || END < 0) { console.log('FAIL could not locate the identity block'); process.exit(1); }
const src = lines.slice(START, END).join('\n');

let fails = 0;
const check = (name, got, want) => {
  const ok = typeof want === 'function' ? want(got) : String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(got));
};

// --- the synthetic faces, same generator as test-identity.mjs -------------------------------
function mesh(p, ox = 0, oy = 0, k = 1) {
  const pts = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  const at = (i, x, y) => { pts[i] = { x: (x - 0.5) * k + 0.5 + ox, y: (y - 0.5) * k + 0.5 + oy }; };
  const cx = 0.5, eyeY = 0.45;
  const eL = { x: cx - p.eyeHalf, y: eyeY }, eR = { x: cx + p.eyeHalf, y: eyeY };
  const r = p.eyeHalf * 0.25;
  const set = (i, x, y) => at(i, x, y);
  set(33, eL.x - r, eL.y); set(133, eL.x + r, eL.y); set(159, eL.x, eL.y - r * 0.7); set(145, eL.x, eL.y + r * 0.7);
  set(362, eR.x + r, eR.y); set(263, eR.x - r, eR.y); set(386, eR.x, eR.y - r * 0.7); set(374, eR.x, eR.y + r * 0.7);
  const tipY = eyeY + p.noseLen;
  set(4, cx, eyeY); set(6, cx, eyeY + p.noseLen * 0.55); set(1, cx, tipY); set(2, cx, tipY + 0.01);
  set(98, cx - p.wingHalf, tipY + 0.005); set(327, cx + p.wingHalf, tipY + 0.005);
  const mouthY = eyeY + p.mouthDrop;
  set(61, cx - p.mouthHalf, mouthY); set(291, cx + p.mouthHalf, mouthY);
  set(152, cx, mouthY + p.chinDrop);
  set(234, cx - p.jawHalf, mouthY); set(454, cx + p.jawHalf, mouthY);
  set(50, cx - p.cheekHalf, eyeY + 0.07); set(280, cx + p.cheekHalf, eyeY + 0.07);
  set(116, cx - p.cheekHalf * 0.8, eyeY + 0.1); set(345, cx + p.cheekHalf * 0.8, eyeY + 0.1);
  set(107, cx - p.browHalf, eyeY - 0.035); set(336, cx + p.browHalf, eyeY - 0.035);
  return pts;
}
const A = { eyeHalf: 0.08, noseLen: 0.052, mouthDrop: 0.075, mouthHalf: 0.056, chinDrop: 0.055,
  jawHalf: 0.105, cheekHalf: 0.092, browHalf: 0.076, wingHalf: 0.023 };
const B = { eyeHalf: 0.078, noseLen: 0.066, mouthDrop: 0.068, mouthHalf: 0.046, chinDrop: 0.062,
  jawHalf: 0.118, cheekHalf: 0.081, browHalf: 0.064, wingHalf: 0.029 };
// A third head, far enough from both of the above to be its own student when a test asks for three IDs
// in one frame.
const C3 = { eyeHalf: 0.066, noseLen: 0.058, mouthDrop: 0.086, mouthHalf: 0.062, chinDrop: 0.047,
  jawHalf: 0.094, cheekHalf: 0.104, browHalf: 0.058, wingHalf: 0.034 };

const NAMES = { hs1: 'HS 1', hs2: 'HS 2', hs3: 'HS 3', hs4: 'HS 4' };

/**
 * A fresh copy of the shipped identity block with the browser globals it expects.
 *
 * Every mutable page variable is re-created per call, so one scenario cannot leak state into the next
 * the way two tabs of the same page would.
 */
function makePage(three) {
  const cv = { width: 640, height: 480 };
  const C = { GRAY: [136, 136, 136], HINT_AMBER: [255, 160, 0], PRIMARY: [102, 80, 164],
    SEI_GOOD: [46, 125, 50], ALERT_ORANGE: [239, 108, 0] };
  const rowY = (y) => Math.max(0, Math.min(y, cv.height - 24));
  const seen = { plates: [], binds: [], logs: [], stats: [], sessions: [], saved: [], uncal: false };
  const faceM = new FaceMatcher();
  for (let i = 0; i < 6; i++) faceM.addSample('hs1', faceSignature(mesh(A)));
  for (let i = 0; i < 6; i++) faceM.addSample('hs2', faceSignature(mesh(B)));
  if (three) for (let i = 0; i < 6; i++) faceM.addSample('hs3', faceSignature(mesh(C3)));

  // A stand-in for MonitorSession that keeps a separate history per student - which is the whole point
  // of the peer pass. hs2 is the tired one and hs1 stays clean, so one shared box would show up as two
  // identical texts, and a peer session that borrowed the bound profile would show up as hs1 in here.
  class FakeProfile {
    constructor(id) { this.id = id; this.name = NAMES[id] || id; this.saved = 0; this.sessions = 0; }
    sessionCount() { return this.sessions; }
    totalValidMs() { return this.sessions * 600000; }
    isReady() { return this.sessions >= 5; }
  }
  class FakeSession {
    constructor() {
      this.profile = null; this.sens = null; this.size = null; this.paused = 0; this.frames = 0;
      this.saves = 0; this.ends = 0; this.open = false;
      seen.sessions.push(this);
    }
    setProfile(p) { this.profile = p; }
    setSensitivity(v) { this.sens = v; }
    setFrameSize(w, h) { this.size = [w, h]; }
    pause() { this.paused++; }
    reset() { this.open = false; }
    // The page opens a run when calibration finishes; the fake is "calibrated" from the first frame, so
    // the first process is the moment a HabitSession would have started.
    saveHabitSession() {
      if (!this.profile || !this.open) return null;
      this.saves++;
      return { changed: true, reason: null, summary: { validMs: 600000 } };
    }
    endHabitSession() {
      const out = this.saveHabitSession();
      if (!out) return null;
      this.ends++;
      this.open = false;
      this.profile.sessions++;
      return out;
    }
    process() {
      this.frames++;
      this.open = true;
      if (seen.uncal) {
        return { calibrated: false, sei: null, alertCode: null, alertHeld: false, personalSeiMean: null,
          calibration: { frames: 12, target: 60 }, qualityNote: 'ok' };
      }
      const id = this.profile && this.profile.id;
      return id === 'hs2'
        ? { calibrated: true, sei: 41, alertCode: 'LOOK_AWAY', alertHeld: false, personalSeiMean: 78,
            calibration: { frames: 60, target: 60 }, qualityNote: 'ok' }
        : { calibrated: true, sei: 88, alertCode: null, alertHeld: false, personalSeiMean: 80,
            calibration: { frames: 60, target: 60 }, qualityNote: 'ok' };
    }
  }
  // One FakeProfile per id, for the life of the page, because that is what localStorage is for this leg:
  // two peer sessions for the same child, or a peer session and the measured one, must land on one object.
  const profiles = {};
  const loadProfile = (id) => (profiles[id] || (profiles[id] = new FakeProfile(id)));
  const toHud = (r) => ({ qualityNote: r.qualityNote });
  const alertSentence = (code) => (code ? '[cảnh báo ' + code + ']' : '');
  const contextNearby = () => null;

  // `stat` and `$` are the page's own line-under-the-camera and element lookup. The enrolment result
  // now speaks there as well as in the log, so running the shipped learnTick needs both handed in -
  // stubbing them is what keeps this a test of the real source instead of a paraphrase of it.
  const body = new Function('cv', 'C', 'rowY', 'plate', 'log', 'stat', 'students', '$', 'ownerOf',
    'nameOf', 'currentId',
    'bindStudent', 'faceM', 'assignFaces', 'faceSignature', 'faceGate', 'IDENTITY', 'saveFace', 'seen',
    'MonitorSession', 'loadProfile', 'toHud', 'alertSentence', 'contextNearby', 'sensLevel',
    'persistProfile', 'HABIT_AUTOSAVE_MS', 'PEER_GONE_MS',
    `let idStatus = null, faceLabels = null, absentSinceMs = 0, lastGapMs = 0, seatArmed = true,
         lastSwitchMs = 0, learningId = null, idAtMs = 0, autoIdOn = true, recPeersOn = true,
         measureIdx = 0, boxes = null, faceRows = null, peerAlerts = null, peerSessions = new Map(),
         learnUntilMs = 0, learnNextMs = 0, learnGot = 0, learnSkipped = 0, learnSkipNote = '',
         builtNumFaces = 0,
         bound = { id: 'hs1', name: 'HS 1' };
     ${src}
     return { idTick, multiTick, peerTick, commitPeer, pickMeasure, facePlateAt, learnTick, seen, faceM,
       // The button handler's own bookkeeping, copied line for line from the shipped onclick.
       startLearn: (id, t) => { learningId = id; learnUntilMs = t + IDENTITY.LEARN_HOLD_MS;
         learnNextMs = 0; learnGot = 0; learnSkipped = 0; learnSkipNote = ''; faceM.resetVotes(); },
       setBound: (id) => { bound = { id, name: nameOf(id) };
         const asPeer = peerSessions.get(id);
         if (asPeer) { if (recPeersOn) commitPeer(asPeer, true, 1e9); peerSessions.delete(id); } },
       get bound() { return bound; },
       setBoxes: (b) => { boxes = b; },
       setAuto: (v) => { autoIdOn = v; },
       setRecPeers: (v) => { recPeersOn = v; },
       setLearning: (v) => { learningId = v; },
       // The face cap makeLandmarker wrote when the model was created, and the dropdown's current value.
       // Both decide the hint in the enrolment result line, so a test has to be able to set them apart.
       setBuiltFaces: (n) => { builtNumFaces = n; },
       setNfaces: (v) => { seen.nfaces = String(v); },
       setMeasureIdx: (v) => { measureIdx = v; },
       // loadProfile memoises, so this is the same object the page wrote, not a fresh read.
       profile: (id) => loadProfile(id),
       peerSession: (id) => { const q = peerSessions.get(id); return q ? q.s : null; },
       state: () => ({ idStatus, faceLabels, measureIdx, learningId, seatArmed, absentSinceMs,
         lastGapMs, peerAlerts, nPeers: peerSessions.size, learnGot, learnSkipped, learnSkipNote }),
     };`);
  return body(cv, C, rowY,
    (x, y, text, colour) => seen.plates.push({ x, y, text, colour }),
    (m) => seen.logs.push(m),
    (m) => seen.stats.push(m),
    () => (three ? ['hs1', 'hs2', 'hs3'] : ['hs1', 'hs2']).map((id) => ({ id, name: NAMES[id] })),
    () => ({ value: seen.nfaces || '1' }),
    // The person boxes this page pairs a face with: one box per head, wide enough to contain the nose.
    (persons, x, y) => (persons || []).find((p) => x >= p.x0 * cv.width && x <= p.x1 * cv.width) || null,
    (id) => NAMES[id] || id,
    () => 'hs1',
    (id, why) => { seen.binds.push({ id, why }); },
    faceM, assignFaces, faceSignature, faceGate, IDENTITY,
    (id, list) => { seen.faces = list; return true; }, seen,
    FakeSession, loadProfile, toHud, alertSentence, contextNearby, 1,
    (p) => seen.saved.push(p.id), 30000, 20000);
}

// --- 1. two heads, two names, no switching --------------------------------------------------
{
  const p = makePage();
  const faces = [mesh(A, -0.16), mesh(B, 0.16)];
  p.idTick(faces, 1000);
  const s = p.state();
  check('two faces produce two labels', s.faceLabels && s.faceLabels.length, 2);
  check('the labels are the two different students', s.faceLabels.map((l) => l.text).join(' | '),
    (a) => a.includes('HS 1') && a.includes('HS 2') && !a.includes('chưa nhận ra'));
  check('the seated student is marked as the measured one', s.faceLabels[0].text, 'HS 1 (đang đo)');
  check('no profile switch happened with two people in frame', p.seen.binds.length, 0);
  check('the frame says what it refused to do', s.idStatus.text,
    (a) => a.includes('2 người trong khung') && a.includes('không tự đổi hồ sơ'));
  check('ten votes in a crowded frame still bind nobody', (() => {
    for (let i = 2; i <= 11; i++) p.idTick(faces, i * 1000);
    return p.seen.binds.length;
  })(), 0);
}

// --- 2. which head the column follows --------------------------------------------------------
{
  const p = makePage();
  p.idTick([mesh(A, -0.16), mesh(B, 0.16)], 1000);
  check('bound student keeps the measured slot', p.state().measureIdx, 0);
  p.idTick([mesh(B, -0.16), mesh(A, 0.16)], 2000);
  check('and follows them when the model lists the other head first', p.state().measureIdx, 1);
  p.setBound('hs9');
  p.setMeasureIdx(0);
  p.idTick([mesh(B, -0.16), mesh(A, 0.16)], 3000);
  check('an unknown profile falls back to the head already being measured', p.state().measureIdx, 0);
}

// --- 3. the single-face path is untouched ----------------------------------------------------
{
  const p = makePage();
  p.idTick(null, 0);
  for (let i = 1; i <= 4; i++) p.idTick([mesh(A)], i * 1000);
  check('one known head does not switch', p.seen.binds.length, 0);
  p.idTick(null, 5000);
  p.idTick(null, 6600);            // chair empty for longer than VACANCY_MS
  // MIN_HOLD_MS keeps two auto-switches 20 s apart, so the new sitting is timed after that window -
  // a switch refused here is the seat-change guard working, not the identity layer failing.
  for (let i = 30; i <= 33; i++) p.idTick([mesh(B)], i * 1000);
  check('one new head after an empty chair switches', p.seen.binds.length, 1);
  check('to the right student', p.seen.binds[0] && p.seen.binds[0].id, 'hs2');
  p.idTick([mesh(A)], 11000);
  check('a lone head clears the labels', p.state().faceLabels, null);
}

// --- 4. enrolment cannot run on a crowded frame ---------------------------------------------
{
  const p = makePage();
  p.setLearning('hs1');
  p.idTick([mesh(A, -0.16), mesh(B, 0.16)], 1000);
  check('learning stops when a second head appears', p.state().learningId, null);
  check('and the operator is told why', p.seen.logs.some((m) => m.includes('đã dừng học')), true);
  check('nothing was labelled from a half-finished enrolment', p.state().faceLabels, null);
  check('no sample was added to the bank', p.faceM.count('hs1'), 6);
}

// --- 5. an unknown head is named as unknown, not as a classmate -----------------------------
{
  const p = makePage();
  const D = { eyeHalf: 0.095, noseLen: 0.038, mouthDrop: 0.092, mouthHalf: 0.071, chinDrop: 0.041,
    jawHalf: 0.088, cheekHalf: 0.101, browHalf: 0.09, wingHalf: 0.019 };
  p.idTick([mesh(A, -0.16), mesh(D, 0.16)], 1000);
  const s = p.state();
  check('the enrolled head is still named', s.faceLabels[0].text.includes('HS 1'), true);
  // The stranger must not be given a name at all. Whether the page says "chưa nhận ra" or "trùng tên
  // bạn bên cạnh" depends on whose radius the stranger falls in; both are the same refusal.
  check('the stranger is admitted as unplaced', /chưa nhận ra|trùng tên/.test(s.faceLabels[1].text)
    && !/HS \d/.test(s.faceLabels[1].text), true);
  check('with its distance printed', /\d+\.\d\d lần ngưỡng/.test(s.faceLabels[1].text), true);
  check('and one of two heads got a name', s.idStatus.text.includes('gọi tên được 1/2'), true);
}

// --- 6. the plate geometry follows the mirrored picture --------------------------------------
{
  const p = makePage();
  const at = p.facePlateAt(mesh(A, 0));
  check('the natural centre stays the centre', at.x, 320);
  const off = p.facePlateAt(mesh(A, 0.2));
  check('a head to the right of the sensor is labelled on the LEFT of the selfie view',
    off.x < at.x, true);
  const before = p.seen.plates.length;
  p.idTick([mesh(A, -0.16), mesh(B, 0.16)], 1000);
  check('idTick only decides; the frame loop does the drawing', p.seen.plates.length, before);
}

// --- 7. each of the other children gets a box of their own ----------------------------------
{
  const p = makePage();
  const faces = [mesh(A, -0.16), mesh(B, 0.16)];
  p.idTick(faces, 1000);
  p.peerTick(faces, [null, null], 1000, 0.8);
  const a = p.state().peerAlerts;
  check('two heads, one measured, one peer box', a && a.length, 1);
  check('the box belongs to the head that is not being measured', a[0].i, 1);
  check('and carries that child\'s own name', a[0].text.includes('HS 2'), true);
  check('with that child\'s own SEI, not the measured child\'s', a[0].text.includes('SEI 41'), true);
  check('and that child\'s own warning sentence', a[0].text.includes('[cảnh báo LOOK_AWAY]'), true);
  check('coloured as a warning', String(a[0].colour), String([239, 108, 0]));
  const s = p.seen.sessions;
  check('exactly one peer session exists', s.length, 1);
  check('and it was loaded with HS 2\'s profile, not the seated child\'s', s[0].profile.id, 'hs2');
  check('copying the sensitivity the operator set', s[0].sens, 1);
  check('and the frame size the column is using', s[0].size.join('x'), '640x480');
  for (let i = 1; i < 5; i++) p.peerTick(faces, [null, null], 1000 + i * 33, 0.8);
  check('four more frames reuse that one history instead of opening four', p.seen.sessions.length, 1);
  check('which is why the peer has five samples, not one', s[0].frames, 5);
  check('and only one peer bank entry', p.state().nPeers, 1);
}

// --- 7b. three heads: the named peer and the stranger are described differently --------------
{
  const p = makePage();
  const D = { eyeHalf: 0.095, noseLen: 0.038, mouthDrop: 0.092, mouthHalf: 0.071, chinDrop: 0.041,
    jawHalf: 0.088, cheekHalf: 0.101, browHalf: 0.09, wingHalf: 0.019 };
  const faces = [mesh(A, -0.16), mesh(B, 0.0), mesh(D, 0.16)];
  p.idTick(faces, 1000);
  p.peerTick(faces, [null, null, null], 1000, 0.8);
  const a = p.state().peerAlerts;
  check('every head that is not measured gets a box', a.length, 2);
  check('the enrolled one with numbers', a[0].text.includes('SEI 41'), true);
  check('the stranger without them', a[1].text.includes('SEI'), false);
  check('because the machine will not guess who that is', a[1].text.includes('chưa biết em là ai'), true);
  check('so no history was opened for the stranger', p.seen.sessions.length, 1);
  check('two boxes, two different texts', a[0].text !== a[1].text, true);
  check('each hanging under its own head', a[0].i !== a[1].i, true);
  // Printed in full so a reviewer can read what the operator would actually see on the picture.
  check('what the two boxes say', a.map((x) => x.text).join('   ||   '), (s) => s.length > 10);
}

// --- 7c. the peer verdict decides the colour, and calibration is admitted -------------------
{
  const p = makePage();
  const faces = [mesh(A, -0.16), mesh(B, 0.16)];
  p.idTick(faces, 1000);
  p.setMeasureIdx(1);                       // now HS 1 is the peer and HS 2 is being measured
  p.peerTick(faces, [null, null], 1000, 0.8);
  const q = p.state().peerAlerts[0];
  check('the peer box follows the peer, not the dropdown', q.text.includes('HS 1'), true);
  check('a quiet peer is not painted as a warning', q.text.includes('không cảnh báo'), true);
  check('in the good colour', String(q.colour), String([46, 125, 50]));
  p.setMeasureIdx(0);
  p.seen.uncal = true;
  p.peerTick(faces, [null, null], 2000, 0.8);
  const r = p.state().peerAlerts[0];
  check('an uncalibrated peer says so instead of scoring', /đang hiệu chuẩn 12\/60/.test(r.text), true);
  check('and prints no SEI', r.text.includes('SEI'), false);
  check('in the grey "not yet" colour', String(r.colour), String([136, 136, 136]));
  p.seen.uncal = false;
}

// --- 7d. a peer who steps out is paused, then forgotten -------------------------------------
{
  const p = makePage();
  const faces = [mesh(A, -0.16), mesh(B, 0.16)];
  p.idTick(faces, 1000);
  p.peerTick(faces, [null, null], 1000, 0.8);
  const peer = p.seen.sessions[0];
  p.idTick([mesh(A, -0.16)], 2000);
  p.peerTick([mesh(A, -0.16)], [null], 2000, 0.8);
  check('a lone head leaves no peer boxes', p.state().peerAlerts.length, 0);
  check('and pauses the absent child rather than averaging them', peer.paused, 1);
  check('their history is kept while they are only away a moment', p.state().nPeers, 1);
  p.peerTick([mesh(A, -0.16)], [null], 70000, 0.8);
  check('a minute away and the half-history is dropped', p.state().nPeers, 0);
  p.idTick(faces, 71000);
  p.peerTick(faces, [null, null], 71000, 0.8);
  check('so the return opens a fresh history, not the old one', p.seen.sessions.length, 2);
  check('and the box is back', p.state().peerAlerts.length, 1);
}

// --- 7e. rebinding a profile discards that child\'s peer history ----------------------------
{
  const p = makePage();
  const faces = [mesh(A, -0.16), mesh(B, 0.16)];
  p.idTick(faces, 1000);
  p.peerTick(faces, [null, null], 1000, 0.8);
  check('HS 2 has a peer history', p.state().nPeers, 1);
  p.setBound('hs2');
  check('switching the page to them drops it', p.state().nPeers, 0);
}

// --- 8. several IDs recorded in the same minute ---------------------------------------------
{
  const p = makePage(true);                       // the bank knows three students
  const faces = [mesh(A, -0.2), mesh(B, 0), mesh(C3, 0.2)];
  p.idTick(faces, 1000);
  check('three heads get three names', p.state().faceLabels.filter((l) => /HS \d/.test(l.text)).length, 3);
  check('and the frame says three profiles are being written', /đang lưu đồng thời 3 hồ sơ/.test(p.state().idStatus.text), true);
  p.peerTick(faces, [null, null, null], 1000, 0.8);
  check('two bystander sessions, one per head not in the column', p.state().nPeers, 2);
  check('the child in the column has no second session', p.peerSession('hs1'), null);
  check('each bystander got its own profile object', p.peerSession('hs2').profile.name, 'HS 2');
  p.peerTick(faces, [null, null, null], 31000, 0.8);
  check('one 30-second window wrote both bystanders', p.seen.saved.join(','), 'hs2,hs3');
  check('as an update, not as a finished run', p.peerSession('hs2').ends, 0);
  check('and the seated child was not written by this pass', p.seen.saved.includes('hs1'), false);
  check('the box says the record is being kept', p.state().peerAlerts[0].text.includes('đang lưu vào hồ sơ'), true);
  // The three runs are three different verdicts, which is the only reason recording them together is
  // worth anything: one shared number would be one measurement of nobody.
  check('the tired one is warned', /SEI 41/.test(p.state().peerAlerts[0].text), true);
  check('the quiet one is not', /SEI 88/.test(p.state().peerAlerts[1].text), true);
}

// --- 8b. turning simultaneous recording off stops the writes, not the captions ---------------
{
  const p = makePage(true);
  const faces = [mesh(A, -0.2), mesh(B, 0), mesh(C3, 0.2)];
  p.idTick(faces, 1000);
  p.peerTick(faces, [null, null, null], 1000, 0.8);
  p.peerTick(faces, [null, null, null], 31000, 0.8);
  check('on: two writes in the first window', p.seen.saved.length, 2);
  p.setRecPeers(false);
  p.peerTick(faces, [null, null, null], 62000, 0.8);
  check('off: the second window wrote nothing', p.seen.saved.length, 2);
  check('off: the name plate is still there', p.state().peerAlerts.length, 2);
  check('off: and admits it is only a caption', p.state().peerAlerts[0].text.includes('tắt ghi cùng lúc'), true);
  p.idTick(faces, 63000);
  check('off: the frame goes back to counting one profile', /chỉ ghi điểm 1 em \(tắt "Ghi cùng lúc"\)/.test(p.state().idStatus.text), true);
  // The gate that matters with recording off is the closing one: a bystander who gets up must not have a
  // finished run written under their name after the operator said "captions only".
  const two = [mesh(A, -0.2), mesh(B, 0)];
  p.idTick(two, 64000);
  p.peerTick(two, [null, null], 64000, 0.8);
  p.idTick(two, 85000);
  p.peerTick(two, [null, null], 85000, 0.8);
  check('off: and a bystander leaving wrote no run either', p.seen.saved.join(','), 'hs2,hs3');
  check('off: their session still went', p.peerSession('hs3'), null);
  check('off: the two still in shot are still captioned', p.state().peerAlerts.length, 1);
}

// --- 8c. a bystander who gets up closes their own run ----------------------------------------
{
  const p = makePage(true);
  const faces = [mesh(A, -0.2), mesh(B, 0), mesh(C3, 0.2)];
  p.idTick(faces, 1000);
  p.peerTick(faces, [null, null, null], 1000, 0.8);
  const stay = [mesh(A, -0.2), mesh(C3, 0.2)];   // HS 2 gets up, HS 3 stays
  p.idTick(stay, 5000);
  p.peerTick(stay, [null, null], 5000, 0.8);
  check('a few seconds out and the run is still open', p.peerSession('hs2').ends, 0);
  check('its history kept', p.state().nPeers, 2);
  const gone = p.peerSession('hs2');
  p.idTick(stay, 26000);
  p.peerTick(stay, [null, null], 26000, 0.8);
  check('twenty seconds out closes it', gone.ends, 1);
  check('under the name that was measured, not the dropdown\'s', p.profile('hs2').sessions, 1);
  check('the log says a camera wrote it', p.seen.logs.some((m) => /camera tự ghi/.test(m) && /HS 2/.test(m)), true);
  check('the child who stayed is untouched', p.peerSession('hs3').ends, 0);
  check('so one frame can hold one finished run and one still open', p.state().nPeers, 1);
  check('and no run was ever opened for the seated child', p.peerSession('hs1'), null);
}

// --- 8d. a stranger in frame is never recorded ----------------------------------------------
{
  const p = makePage();
  const D = { eyeHalf: 0.095, noseLen: 0.038, mouthDrop: 0.092, mouthHalf: 0.071, chinDrop: 0.041,
    jawHalf: 0.088, cheekHalf: 0.101, browHalf: 0.09, wingHalf: 0.019 };
  const faces = [mesh(A, -0.16), mesh(D, 0.16)];
  p.idTick(faces, 1000);
  for (const t of [1000, 31000, 62000]) p.peerTick(faces, [null, null], t, 0.8);
  check('a minute of an unknown face wrote nothing', p.seen.saved.length, 0);
  check('no session was opened for them', p.state().nPeers, 0);
  check('and the count of profiles in the frame stayed at one', /chỉ 1 hồ sơ trong khung được ghi/.test(p.state().idStatus.text), true);
}

// --- 8e. switching the page to a bystander hands the run over, once --------------------------
{
  const p = makePage();
  const faces = [mesh(A, -0.16), mesh(B, 0.16)];
  p.idTick(faces, 1000);
  p.peerTick(faces, [null, null], 1000, 0.8);
  p.peerTick(faces, [null, null], 31000, 0.8);
  check('HS 2 was being recorded as a bystander', p.seen.saved.join(','), 'hs2');
  p.setBound('hs2');
  check('selecting them commits that bystander run first', p.profile('hs2').sessions, 1);
  check('and drops the duplicate session', p.state().nPeers, 0);
  check('so the page never holds two sessions for one child', p.peerSession('hs2'), null);
}

// --- 10. the quality gate, run through the shipped page code -------------------------------
{
  // Same yaw model as test-identity.mjs: the plane compresses by cos(theta) and each point walks
  // sideways by sin(theta) times its own depth, so the nose moves most. 60 degrees is where both gate
  // measures are over threshold on this synthetic head.
  const turned = (pts, deg, cx) => {
    const th = (deg * Math.PI) / 180;
    const z = { 1: 0.030, 2: 0.022, 6: 0.016, 4: 0.010, 98: 0.012, 327: 0.012,
      61: 0.004, 291: 0.004, 152: 0.006, 50: -0.012, 280: -0.012, 234: -0.014, 454: -0.014 };
    return pts.map((p, i) => ({
      x: cx + (p.x - cx) * Math.cos(th) + Math.sin(th) * (z[i] || 0),
      y: p.y,
    }));
  };
  // 10a. one head, turned away, and it is the OTHER child: without the gate these ten ticks would
  // rebind the page to hs2, so the control below is what makes the refusal mean something.
  {
    const p = makePage();
    const bad = turned(mesh(B), 60, 0.5);
    // Timed past MIN_HOLD_MS: a switch blocked at t=3 s would be the seat-change guard, not the gate.
    for (let i = 25; i <= 34; i++) p.idTick([bad], i * 1000);
    const s = p.state();
    check('a turned head never binds, however long it stays', p.seen.binds.length, 0);
    check('the refusal names the reason and keeps the numbers', s.idStatus.text,
      (a) => a.includes('quay ngang') && a.includes('d ') && a.includes('không chắc tên'));
    const q = makePage();
    for (let i = 25; i <= 34; i++) q.idTick([mesh(B)], i * 1000);
    check('the same child facing the lens does bind', q.seen.binds.length, 1);
  }
  // 10b. two heads: the clear one keeps its name, the turned one is marked as refused.
  {
    const p = makePage();
    const faces = [mesh(A, -0.16), turned(mesh(B, 0.16), 60, 0.66)];
    p.idTick(faces, 1000);
    const s = p.state();
    check('the clear head is still named', s.faceLabels[0].text.includes('HS 1'), true);
    check('the turned head says it was refused rather than guessed at',
      s.faceLabels[1].text.includes('quay ngang'), true);
    check('the frame counts how many heads it threw away',
      s.idStatus.text.includes('1 em quay ngang'), true);
  }
  // 10c. a run is never OPENED on a gated frame, even when that frame does match a bank.
  {
    const p = makePage(true);
    const tv = faceSignature(turned(mesh(B), 60, 0.66));
    for (let i = 0; i < 3; i++) p.faceM.addSample('hs4', tv);
    const faces = [mesh(A, -0.16), turned(mesh(B, 0.16), 60, 0.66)];
    p.idTick(faces, 1000);
    p.peerTick(faces, [null, null], 1000, 0.8);
    const s = p.state();
    check('a gated head is named but starts no run', [s.nPeers, s.faceLabels[1].text.includes('HS 4')],
      (a) => a[0] === 0 && a[1] === true);
    check('its box says the run was withheld and why',
      s.peerAlerts[0].text.includes('chưa mở phiên') && s.peerAlerts[0].text.includes('quay ngang'), true);
    const back = [mesh(A, -0.16), mesh(B, 0.16)];
    p.idTick(back, 2000);
    p.peerTick(back, [null, null], 2000, 0.8);
    check('the same head facing the lens opens its run', p.state().nPeers, 1);
  }
  // 10d. but a run that is already open keeps ticking: stopping it would be the same claim sideways.
  {
    const p = makePage(true);
    const tv = faceSignature(turned(mesh(C3), 60, 0.66));
    for (let i = 0; i < 3; i++) p.faceM.addSample('hs3', tv);
    const open = [mesh(A, -0.16), mesh(C3, 0.16)];
    p.idTick(open, 1000);
    p.peerTick(open, [null, null], 1000, 0.8);
    check('the bystander run opens while it faces the lens', p.state().nPeers, 1);
    const away = [mesh(A, -0.16), turned(mesh(C3, 0.16), 60, 0.66)];
    p.idTick(away, 2000);
    p.peerTick(away, [null, null], 2000, 0.8);
    const s = p.state();
    check('turning away does not close the open run', s.nPeers, 1);
    check('nor does it lose the child their numbers', s.peerAlerts[0].text.includes('SEI'), true);
    check('and the plate still says the name was not re-decided',
      s.faceLabels[1].text.includes('quay ngang'), true);
  }
}

// --- 11. enrolment keeps only frames the gate accepts ---------------------------------------
{
  const turned = (pts, deg, cx) => {
    const th = (deg * Math.PI) / 180;
    const z = { 1: 0.030, 2: 0.022, 6: 0.016, 4: 0.010, 98: 0.012, 327: 0.012,
      61: 0.004, 291: 0.004, 152: 0.006, 50: -0.012, 280: -0.012, 234: -0.014, 454: -0.014 };
    return pts.map((p, i) => ({
      x: cx + (p.x - cx) * Math.cos(th) + Math.sin(th) * (z[i] || 0),
      y: p.y,
    }));
  };
  // 11a. four seconds of a head turned away must add NOTHING to the bank, and must say so.
  {
    const p = makePage();
    // loadProfile memoises across pages in one Node run, so an earlier section's bank would still be
    // here. Empty it: this section is about what a turned head ADDS, and needs a true zero to start.
    p.faceM.drop('hs2');
    p.startLearn('hs2', 0);
    const bad = turned(mesh(B), 60, 0.5);
    // Past LEARN_HOLD_MS or the window never closes and the summary line is never written.
    for (let t = 0; t <= IDENTITY.LEARN_HOLD_MS + 260; t += 260) p.learnTick(bad, t);
    const s = p.state();
    check('a turned head enrolls no frames', [p.faceM.count('hs2'), s.learnGot], (a) =>
      a[0] === 0 && a[1] === 0);
    check('every refused frame is counted', s.learnSkipped > 10, true);
    if (process.env.DBG) p.seen.logs.forEach((m) => console.log('   LOG ' + m));
    check('and the last refusal is the reason the log gives',
      p.seen.logs.some((m) => m.includes('Không học được khung mặt nào') && m.includes('quay ngang')
        && m.includes('hướng mặt vào ống kính')), true);
  }
  // 11b. the same four seconds facing the lens fills the bank.
  {
    const p = makePage();
    p.startLearn('hs2', 0);
    for (let t = 0; t <= IDENTITY.LEARN_HOLD_MS + 260; t += 260) p.learnTick(mesh(B), t);
    const s = p.state();
    check('a facing head enrolls the whole window', [s.learnGot, p.faceM.count('hs2') > 10],
      (a) => a[0] > 10 && a[1] === true);
    check('nothing was refused, so nothing is mentioned', s.learnSkipped, 0);
    check('the bank on disk is the bank in memory', p.seen.faces.length, p.faceM.count('hs2'));
    check('and the log reports the radius it measured',
      p.seen.logs.some((m) => m.includes('bán kính chấp nhận') && m.includes('trọng số')), true);
  }
  // 11c. a moderate pose that the LOOSER enrolment gate accepts is one the naming gate refuses -
  // which is the whole reason the two thresholds are different numbers.
  {
    const p = makePage();
    // 45 degrees is the angle this synthetic head sits between the two gates at: measured, the naming
    // gate starts refusing at 40 and the enrolment gate not until 60.
    const mid = turned(mesh(B), 45, 0.5);
    p.startLearn('hs2', 0);
    for (let t = 0; t <= IDENTITY.LEARN_HOLD_MS + 260; t += 260) p.learnTick(mid, t);
    const enrolled = p.state().learnGot;
    const q = makePage();
    for (let i = 25; i <= 34; i++) q.idTick([mid], i * 1000);
    check('a 45-degree head is still enrollable', enrolled > 10, true);
    check('and at the same angle naming still refuses to decide on it',
      q.state().idStatus.text.includes('quay ngang') && q.state().idStatus.text.includes('không chắc tên'),
      true);
  }
  // 11d. the enrolment result has to be readable WITHOUT opening the log, and has to say what comes
  // next: two learned children is the state in which one frame names both of them.
  {
    const p = makePage();
    p.faceM.drop('hs2');
    p.startLearn('hs2', 0);
    for (let t = 0; t <= IDENTITY.LEARN_HOLD_MS + 260; t += 260) p.learnTick(mesh(B), t);
    const line = p.seen.stats[p.seen.stats.length - 1];
    check('the result line names both children the machine now knows',
      line.includes('HS 1') && line.includes('HS 2') && line.includes('tự đọc tên từng em'), true);
    check('and does not tell anyone to reopen the camera when the cap already covers them',
      line.includes('Mở camera'), false);
  }
  // 11e. the cap is the trap: a bank for two children still names nobody until the model was built to
  // look for the second face, so the line has to say that in the same breath as the success.
  {
    const p = makePage();
    p.setBuiltFaces(1);
    p.setNfaces(2);
    p.startLearn('hs2', 0);
    for (let t = 0; t <= IDENTITY.LEARN_HOLD_MS + 260; t += 260) p.learnTick(mesh(B), t);
    const line = p.seen.stats[p.seen.stats.length - 1];
    check('a stale face cap is reported as the reason two heads stay unnamed',
      line.includes('đang tìm 1 mặt') && line.includes('Mở camera'), true);
  }
}

// --- 12. a glance at the wall must not be counted as agreement -------------------------------
{
  const turned = (pts, deg, cx) => {
    const th = (deg * Math.PI) / 180;
    const z = { 1: 0.030, 2: 0.022, 6: 0.016, 4: 0.010, 98: 0.012, 327: 0.012,
      61: 0.004, 291: 0.004, 152: 0.006, 50: -0.012, 280: -0.012, 234: -0.014, 454: -0.014 };
    return pts.map((p, i) => ({
      x: cx + (p.x - cx) * Math.cos(th) + Math.sin(th) * (z[i] || 0),
      y: p.y,
    }));
  };
  // Two frames straight, one turned, two straight again: four agreeing frames in total, which is what a
  // switch asks for, but never three in a row. The gated frame is skipped by the vote rather than
  // counted, so without the streak reset the count simply carries on across the child looking at the
  // wall and the page rebinds mid-sitting. One tick per VOTE_MS, because idTick measures at most once a
  // second and a tighter loop would only be measuring the throttle.
  {
    const p = makePage();
    const away = turned(mesh(B), 60, 0.5);
    for (const t of [25000, 26000]) p.idTick([mesh(B)], t);
    p.idTick([away], 27000);
    for (const t of [28000, 29000]) p.idTick([mesh(B)], t);
    check('a turned frame in the middle stops the switch', p.seen.binds.length, 0);
    check('and the streak restarts on the far side of it', p.faceM.voting.count, 2);
  }
  // Same frames with nothing between them: the sequence is not inert, it is the turn that helps.
  {
    const q = makePage();
    for (const t of [25000, 26000, 27000, 28000]) q.idTick([mesh(B)], t);
    check('the same frames without the turn do bind', q.seen.binds.length, 1);
  }
  // 12c. the crowd path has to be told which heads were refused, not just refuse them: with two heads
  // wearing the same bank entry, the flagged one is the one that matches better (a turned face is
  // foreshortened toward the shape it was enrolled from), so dropping the gates argument moves the name
  // off the child facing the lens and onto the one looking at the wall. The gate is hand-made here rather
  // than produced by faceGate because this yaw model damages the signature far more than it would on a
  // real child - see the note on the ordering contract in test-identity.mjs.
  {
    const p = makePage();
    const B2 = { ...B, mouthHalf: B.mouthHalf * 1.06, noseLen: B.noseLen * 0.94,
      chinDrop: B.chinDrop * 1.06 };
    const turnedSig = faceSignature(mesh(B, -0.16));
    const clearSig = faceSignature(mesh(B2, 0.16));
    check('the refused head is the closer match, so the contest is real', (() => {
      const t = p.faceM.matchAll(turnedSig)[0], c = p.faceM.matchAll(clearSig)[0];
      return t.inside && c.inside && c.dist - t.dist > 0.02;
    })(), true);
    p.idTick([mesh(B, -0.16), mesh(B2, 0.16)], 1000);
    p.multiTick([mesh(B, -0.16), mesh(B2, 0.16)], [turnedSig, clearSig],
      [{ reason: 'yaw', asym: 0.6, shift: 0.2, edge: 0.4 }, null]);
    const s = p.state();
    check('the clear head keeps the name in a crowd', s.faceLabels[1].text.includes('HS 2'), true);
    check('and the turned head is the one left without it',
      !s.faceLabels[0].text.includes('HS 2'), true);
    check('the turned head is marked as refused', s.faceLabels[0].text.includes('quay ngang'), true);
  }
}

// --- 9. the loop wiring, read out of the shipped source -------------------------------------
{
  const html = lines.join('\n');
  // Checked by shape, not by literal text: the Vietnamese in this page is written with combining marks
  // in places, and a needle typed here can miss it for a reason that has nothing to do with the code.
  const initLog = (html.match(/log\([^\n]*FaceLandmarker[^\n]*/) || [''])[0];
  const need = [
    ['the detector keeps every head', 'lastFaces = res && res.faceLandmarks'],
    ['idTick is called with the array', 'idTick(lastFaces, t)'],
    ['the measured face comes after idTick', 'lastPts = lastFaces ? (lastFaces[measureIdx] || lastFaces[0]) : null'],
    ['numFaces is a control', "parseInt($('nfaces').value"],
    ['blendshapes come from the measured head', 'faceBlendshapes: [(res.faceBlendshapes || [])[measureIdx]]'],
    ['labels are painted', 'if (faceLabels && lastFaces)'],
    ['every head is kept for the peer pass', 'lastFaces && lastFaces.length > 1 && faceRows'],
    ['peers are judged before drawing', 'peerTick(lastFaces, res.faceBlendshapes, t, light)'],
    ['peer boxes are painted', 'if (peerAlerts && lastFaces)'],
    ['a peer under one head is paused', 'peer.s.pause(t)'],
    ['a bystander out for the phone\'s break length gets their run closed', 'if (t - peer.goneAt >= PEER_GONE_MS)'],
    ['the break length is the phone\'s own', 'const PEER_GONE_MS = BREAK_DETECT_MS'],
    ['bystander runs autosave on the same clock', 'if (recPeersOn && t - peer.saveAt >= HABIT_AUTOSAVE_MS)'],
    ['a peer run is committed to that child\'s profile', 'if (out.changed) persistProfile(p)'],
    ['pressing Dừng closes the bystander runs too', 'if (recPeersOn) commitPeer(peer, true, performance.now());'],
    ['re-calibrating closes them as well', 'commitPeer(peer, true, performance.now());'],
    ['rebinding commits that child\'s bystander run', 'commitPeer(asPeer, true, performance.now())'],
    ['one profile per head is what the frame counts', 'const recN = recPeersOn ? Math.max(1, ids.size) : 1'],
    ['the operator can turn the writes off', "id=\"recpeers\""],
    ['and the control is read', "$('recpeers').onchange"],
    ['enrolment refuses a crowd', 'Học mặt chỉ chạy khi'],
    ['stop() clears the face state', 'lastFaces = null'],
    ['the column counts the heads in the frame', 'hudLines(toHud(r), lastFaces ? lastFaces.length : 1'],
    ['a single head is gated before it can vote', "const gate = faceGate(pts, 'match');"],
    // Anchored on the code after it: resetVotes() appears seven times in this page, so a bare needle
    // passes no matter which of them the gate block keeps.
    ['the voting streak is broken, not counted',
      'faceM.resetVotes();\n    return;\n  }\n  const voted = faceM.vote('],
    ['every head in a crowd is gated', "faces.map((f) => faceGate(f, 'match'))"],
    ['and the assignment is told which ones', 'assignFaces(sigs, faceM, gates)'],
    ['a peer run opens only on an accepted frame', "faceGate(faces[i], 'match')"],
    ['enrolment uses the looser gate', "faceGate(pts, 'learn')"],
    ['and counts what it threw away', 'learnSkipped++'],
    ['the refusal is explained in words', 'function gateNote(g)'],
    ['the plate carries the reason', "' · ' + gateNote(gate)"],
    ['the summary counts refused heads', 'const gateN = (gates || []).filter(Boolean).length'],
    ['the face cap tells the operator when it applies', "$('nfaces').onchange"],
    ['four heads is the ceiling', "Math.max(1, Math.min(4, parseInt($('nfaces').value, 10)"],
  ];
  for (const [what, needle] of need) check('wiring: ' + what, html.includes(needle), true);
  const ident = readFileSync(DIST + '/js/identity.mjs', 'utf8');
  for (const [what, needle] of [
    ['the gate is exported', 'export function faceGate(pts, mode)'],
    ['naming thresholds are named numbers', 'YAW_MATCH_ASYM: 0.30'],
    ['enrolment thresholds are looser', 'YAW_LEARN_ASYM: 0.38'],
    ['distances go through the weighted path', 'gdist(a, b)'],
    ['weights wait for a measured bank', 'MIN_SIGMA_DOF: 6'],
    ['and say so', 'weightsActive()'],
  ]) check('identity: ' + what, ident.includes(needle), true);
  check('wiring: the cap is logged at start', /nfaces/.test(initLog), true);
  check('the two-head setting is the default', /<option value="2" selected>/.test(html), true);
  check('the phone-parity default is still one measured face', /numFaces: nf,/.test(html)
    && /const nf = Math.max\(1, Math.min\(4, parseInt\(\$\('nfaces'\).value, 10\) \|\| 1\)\);/.test(html), true);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
