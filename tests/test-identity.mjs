// Scratch test for js/identity.mjs - synthetic meshes, no browser. Run with the bundled Node.
import { faceSignature, faceGate, IDENTITY, FaceMatcher, assignFaces } from
  '../dist/js/identity.mjs';

// A parametric "face" laid out in normalized frame coordinates, using only the indices identity.mjs
// reads. Ring points are placed symmetrically so the eye-centre average returns the centre exactly.
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
  const chinY = mouthY + p.chinDrop;
  set(152, cx, chinY);
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

const jit = (p, s) => {
  const o = {};
  for (const key of Object.keys(p)) o[key] = p[key] + (Math.random() * 2 - 1) * s;
  return o;
};

let fails = 0;
const check = (name, got, want) => {
  const ok = typeof want === 'function' ? want(got)
    : typeof want === 'string' ? got === want
      : typeof want === 'boolean' ? got === want
        : Math.abs(got - want) < 1e-9;
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(got));
};

const sA = faceSignature(mesh(A));
check('signature has 20 dims', sA.length, 20);
check('invariant to translation', faceSignature(mesh(A, 0.13, -0.21)), (v) => {
  const d = Math.max(...v.map((x, i) => Math.abs(x - sA[i])));
  return d < 1e-12;
});
check('invariant to scale (distance ratios)', faceSignature(mesh(A, 0, 0, 1.6)), (v) => {
  const d = Math.max(...v.map((x, i) => Math.abs(x - sA[i])));
  return d < 1e-12;
});
check('null on a face too small', faceSignature(mesh(A, 0, 0, 0.2)) === null, true);
check('null on a broken mesh', faceSignature(null) === null, true);

// What yaw does to it: the far side of the face is compressed in the image.
const yawed = mesh(A, 0, 0, 1);
for (const i of [234, 50, 116, 61, 98, 33, 107]) yawed[i] = { x: yawed[i].x - 0.012, y: yawed[i].y };
const dYaw = Math.hypot(...sA.map((v, i) => v - faceSignature(yawed)[i]));
console.log('yaw(12 mm of compression) moves the signature by d=' + dYaw.toFixed(4));

const m = new FaceMatcher();
for (let i = 0; i < 5; i++) m.addSample('hs1', faceSignature(mesh(jit(A, 0.004))));
for (let i = 0; i < 5; i++) m.addSample('hs2', faceSignature(mesh(jit(B, 0.004))));
console.log('radius hs1=' + m.radius('hs1').toFixed(3) + ' hs2=' + m.radius('hs2').toFixed(3));

const hits = { hs1: 0, hs2: 0, wrong: 0, none: 0 };
const N = 400;
for (let i = 0; i < N; i++) {
  const who = i % 2 ? 'hs2' : 'hs1';
  const r = m.match(faceSignature(mesh(jit(who === 'hs1' ? A : B, 0.004))));
  if (!r || !r.ok) hits.none++; else if (r.id === who) hits[who]++; else hits.wrong++;
}
check('zero wrong ids over ' + N + ' frames', hits.wrong, 0);
check('acceptance above 90%', hits.none < N * 0.1, true);
console.log('  ' + N + ' frames: accepted hs1=' + hits.hs1 + ' hs2=' + hits.hs2
  + ' declined=' + hits.none + ' (a decline asks the operator, a wrong id silently rebinds the profile)');

const mY = new FaceMatcher();
for (let i = 0; i < 4; i++) mY.addSample('hs1', faceSignature(mesh(jit(A, 0.004))));
for (let i = 0; i < 4; i++) mY.addSample('hs2', faceSignature(mesh(jit(B, 0.004))));
const naive = mY.match(faceSignature(yawed));
console.log('yawed frame vs 4 straight-on samples: id=' + naive.id + ' d=' + naive.dist.toFixed(3)
  + ' r=' + naive.radius.toFixed(3) + ' ok=' + naive.ok);
for (let i = 0; i < 4; i++) mY.addSample('hs1', faceSignature(mesh(jit(A, 0.004), -0.012 * (i + 1) * 0.35, 0)));
const learned = mY.match(faceSignature(yawed));
console.log('same frame after 4 yaw samples:      id=' + learned.id + ' d=' + learned.dist.toFixed(3)
  + ' r=' + learned.radius.toFixed(3) + ' ok=' + learned.ok);

const v = [mY.vote('hs1'), mY.vote('hs1'), mY.vote('hs1')];
check('vote switches only on the third frame', v, (a) => a[0] === null && a[1] === null && a[2] === 'hs1');
mY.vote('hs2');
check('a different face restarts the count', mY.vote('hs1'), null);

// --- assignFaces: two heads in one frame, three students in the bank --------------------
// The rule under test is the one the page cannot check for itself: one name per head, never two
// heads wearing the same profile, and a head that cannot be placed stays unnamed instead of borrowing
// the neighbour's name.
const C3 = { eyeHalf: 0.095, noseLen: 0.038, mouthDrop: 0.092, mouthHalf: 0.071, chinDrop: 0.041,
  jawHalf: 0.088, cheekHalf: 0.101, browHalf: 0.09, wingHalf: 0.019 };

const m3 = new FaceMatcher();
for (let i = 0; i < 6; i++) m3.addSample('hs1', faceSignature(mesh(jit(A, 0.004))));
for (let i = 0; i < 6; i++) m3.addSample('hs2', faceSignature(mesh(jit(B, 0.004))));
for (let i = 0; i < 6; i++) m3.addSample('hs3', faceSignature(mesh(jit(C3, 0.004))));

const two = assignFaces([faceSignature(mesh(A, -0.16, 0.02)), faceSignature(mesh(B, 0.16, -0.01))], m3);
check('two faces in frame -> two rows', two.length, 2);
check('left head is hs1', two[0].id, (a) => a === 'hs1');
check('right head is hs2', two[1].id, (a) => a === 'hs2');
check('the two heads got different names', new Set(two.map((r) => r.id)).size, 2);
check('neither head flagged', two.some((r) => r.taken || !r.inside), false);

const three = assignFaces(
  [faceSignature(mesh(C3, -0.2)), faceSignature(mesh(A, 0)), faceSignature(mesh(B, 0.2))], m3);
check('three heads -> three distinct names', new Set(three.map((r) => r.id)).size, 3);
check('names follow the heads, not the order', three.map((r) => r.id).join(','),
  (a) => a === 'hs3,hs1,hs2');

const dupe = assignFaces([faceSignature(mesh(A, -0.16)), faceSignature(mesh(A, 0.16))], m3);
check('one profile claimed by at most one head', dupe.filter((r) => r.id === 'hs1').length, 1);
check('the displaced head stays unnamed and says why',
  dupe.filter((r) => r.taken && r.id === null).length, 1);

const blank = new FaceMatcher();
const unknown = assignFaces([faceSignature(mesh(C3, -0.16)), faceSignature(mesh(jit(B, 0.004), 0.16))],
  blank);
check('empty bank names nobody', unknown.every((r) => r.id === null && r.cands.length === 0), true);

const half = assignFaces([faceSignature(mesh(A, -0.16)), null], m3);
check('a head too small to signature is left unnamed', half[1].id === null && half[1].cands.length === 0, true);
check('the readable head is still named', half[0].id, (a) => a === 'hs1');

// --- 6. per-dimension weights ---------------------------------------------------------------
// Two faces that differ in the dimensions a mesh measures stably (nose length, mouth width) and a
// nuisance jitter of 12 mm of frame put on the jaw and cheek widths alone - which is what a landmark at
// the end of a long lever arm does. Plain Euclidean distance hands the decision to the noisy dimensions;
// weighting by measured noise has to take it back. Seeded so the comparison cannot flip between runs.
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const W1 = { eyeHalf: 0.080, noseLen: 0.052, mouthDrop: 0.075, mouthHalf: 0.056, chinDrop: 0.055,
  jawHalf: 0.105, cheekHalf: 0.092, browHalf: 0.076, wingHalf: 0.023 };
const W2 = { eyeHalf: 0.081, noseLen: 0.070, mouthDrop: 0.062, mouthHalf: 0.043, chinDrop: 0.066,
  jawHalf: 0.106, cheekHalf: 0.093, browHalf: 0.075, wingHalf: 0.024 };
const NOISY = { jawHalf: 0.019, cheekHalf: 0.015, wingHalf: 0.005 };
const rndW = mulberry(20261107);
const jitW = (p) => {
  const o = {};
  for (const k of Object.keys(p)) {
    const amp = NOISY[k] !== undefined ? NOISY[k] : 0.0015;
    o[k] = p[k] + (rndW() * 2 - 1) * amp;
  }
  return o;
};
// One shared draw for both matchers: the only thing allowed to differ is the metric.
const draw = (who, n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(faceSignature(mesh(jitW(who))));
  return out;
};
const wSamples = [draw(W1, 8), draw(W2, 8)];
const wProbes = [draw(W1, 60), draw(W2, 60)];
check('weights: off until the noise has been measured on two students',
  (() => { const m = new FaceMatcher(); m.addSample('w1', wSamples[0][0]); return m.weightsActive(); })(),
  false);
const scoreW = (m) => {
  const out = { correct: 0, wrong: 0, declined: 0 };
  for (const who of [0, 1]) {
    for (const v of wProbes[who]) {
      const r = m.match(v);
      if (!r || !r.ok) out.declined++;
      else if (r.id === (who ? 'w2' : 'w1')) out.correct++;
      else out.wrong++;
    }
  }
  return out;
};
const mk = (useWeights) => {
  const m = new FaceMatcher({ useWeights });
  for (const v of wSamples[0]) m.addSample('w1', v);
  for (const v of wSamples[1]) m.addSample('w2', v);
  return m;
};
const plain = scoreW(mk(false));
const weighted = scoreW(mk(true));
console.log('  120 frames, two faces, noise only on the widths: plain=' + JSON.stringify(plain)
  + '  weighted=' + JSON.stringify(weighted));
check('weighted reports itself active, plain reports itself off',
  [mk(true).weightsActive(), mk(false).weightsActive()], (a) => a[0] === true && a[1] === false);
check('weighting makes the noisy dimensions stop deciding the name',
  weighted.wrong + weighted.declined < plain.wrong + plain.declined, true);
check('weighted names every frame it accepts correctly', weighted.wrong, 0);
check('weighted still declines rather than guesses', weighted.declined <= 20, true);
check('weighting keeps the units: the floor still governs a thin bank',
  mk(true).radius('w1') >= IDENTITY.R_FLOOR, true);
// A bank of one student is the case that must not change at all, because that is the bank a teacher
// actually has on the first day.
const solo = draw(W1, 6);
const onlyW = new FaceMatcher({ useWeights: true });
const onlyP = new FaceMatcher({ useWeights: false });
for (const v of solo) { onlyW.addSample('w1', v); onlyP.addSample('w1', v); }
check('one student: no weights, so weighted and plain agree exactly',
  onlyW.gdist(solo[0], solo[1]) === onlyP.gdist(solo[0], solo[1]), true);
// The rescaling is what keeps R_FLOOR meaningful, and it has one exact case: a bank whose dimensions
// are equally noisy must give the plain Euclidean distance back, digit for digit.
{
  const eq = new FaceMatcher();
  const off = (v, d) => v.map((x) => x + d);
  for (const dte of [0, 0.001, -0.001, 0.002, -0.002]) eq.addSample('u1', off(sA, dte));
  for (const dte of [0, 0.003, -0.003, 0.006, -0.006]) eq.addSample('u2', off(sA, dte));
  const a = sA, b = off(sA, 0.05);
  const plainD = Math.hypot(...a.map((x, i) => x - b[i]));
  check('equal noise on every dimension gives the plain distance back (units preserved)',
    eq.gdist(a, b), (g) => Math.abs(g - plainD) < 1e-9);
  check('that bank is thick enough to be weighted', eq.weightsActive(), true);
}

// --- 7. faceGate ------------------------------------------------------------------------------
// A yaw is applied the way a real head turns: the plane compresses by cos(theta) and every point walks
// sideways by sin(theta) times its own depth, so the nose - the only thing standing proud of the face -
// moves most. The depths are an assumption about a head, which is why the assertions below are about the
// ORDER of the angles and never about a specific one.
function turned(pts, deg, cx = 0.5) {
  const th = (deg * Math.PI) / 180;
  const z = { 1: 0.030, 2: 0.022, 6: 0.016, 4: 0.010, 98: 0.012, 327: 0.012,
    61: 0.004, 291: 0.004, 152: 0.006, 50: -0.012, 280: -0.012, 234: -0.014, 454: -0.014 };
  return pts.map((p, i) => {
    const zz = z[i] || 0;
    return { x: cx + (p.x - cx) * Math.cos(th) + Math.sin(th) * zz, y: p.y };
  });
}
const roll = (pts, deg) => {
  const th = (deg * Math.PI) / 180, cx = 0.5, cy = 0.5;
  return pts.map((p) => ({
    x: cx + (p.x - cx) * Math.cos(th) - (p.y - cy) * Math.sin(th),
    y: cy + (p.x - cx) * Math.sin(th) + (p.y - cy) * Math.cos(th),
  }));
};
{
  const table = [0, 20, 40, 50, 60, 70].map((deg) => {
    const g = faceGate(turned(mesh(A), deg), 'match');
    return deg + '°:' + (g ? g.reason + '(' + Math.round(100 * g.asym) + '/' + Math.round(100 * g.shift) + ')' : 'ok');
  });
  console.log('  gate at increasing yaw: ' + table.join('  '));
  check('a straight head is accepted', faceGate(mesh(A), 'match'), null);
  check('a small turn is accepted', faceGate(turned(mesh(A), 10), 'match'), null);
  check('a big turn is refused', (faceGate(turned(mesh(A), 60), 'match') || {}).reason, 'yaw');
  // The mouth asymmetry is NOT monotone - past ~60 deg the far mouth corner walks under the nose and the
  // difference shrinks again - which is exactly why the gate asks both measures instead of one. The nose
  // offset is monotone, and refusal never comes back.
  check('refusal never returns at a larger angle, and the nose offset keeps growing', (() => {
    const steps = [50, 60, 70].map((deg) => faceGate(turned(mesh(A), deg), 'match'));
    const shifts = steps.map((g) => g && g.shift);
    return steps.every((g) => g && g.reason === 'yaw')
      && shifts[2] > shifts[1] && shifts[1] > shifts[0];
  })(), true);
  check('enrolment tolerates a pose that naming will not',
    (() => {
      for (const deg of [30, 40, 50]) {
        const pts = turned(mesh(A), deg);
        if (faceGate(pts, 'learn') === null && faceGate(pts, 'match') !== null) return true;
      }
      return false;
    })(), true);
  check('an in-plane tilt is NOT yaw (rotation leaves distances alone)',
    faceGate(roll(mesh(A), 18), 'match'), null);
  check('a tilted head still gets the same identity numbers', (() => {
    const u = faceSignature(mesh(A)), v = faceSignature(roll(mesh(A), 18));
    return Math.max(...u.map((x, i) => Math.abs(x - v[i]))) < 1e-9;
  })(), true);
  check('a head cut by the frame edge is refused',
    (faceGate(mesh(A, -0.45), 'match') || {}).reason, 'clip');
  check('a head at the centre is not refused for the edge',
    (faceGate(mesh(A, -0.16), 'match') || {}).reason !== 'clip', true);
  check('a face too small to measure is refused before it can vote',
    (faceGate(mesh(A, 0, 0, 0.15), 'match') || {}).reason, 'small');
  check('a mesh with a lost landmark cannot be trusted', (() => {
    const pts = mesh(A);
    pts[61] = { x: NaN, y: 0.5 };
    return (faceGate(pts, 'match') || {}).reason;
  })(), 'mesh');
  // The ordering contract. The first version of this compared two translated copies of one head, whose
  // signatures are float-identical, so the test passed whichever way the sort fell and the tie-break was
  // never exercised. Here the gated head is the one that matches BETTER - which is what a real yaw does:
  // foreshortening pulls a turned face toward the shape the bank was measured from. Only settling gated
  // heads last keeps the name on the child facing the lens, and the control line below proves it is the
  // ordering doing the work rather than the draw, so this bank is seeded and additive noise is kept at
  // the level store.mjs actually sees.
  const seedOrder = (() => { let x = 20261107; return () =>
    ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  const m7 = new FaceMatcher();
  for (let i = 0; i < 6; i++) {
    const o = {};
    for (const k of Object.keys(A)) o[k] = A[k] + (seedOrder() * 2 - 1) * 0.0015;
    m7.addSample('hs1', faceSignature(mesh(o)));
  }
  const flagged = { reason: 'yaw', asym: 0.9, shift: 0.9, edge: 0.4 };
  const turnedSig = faceSignature(mesh(A));
  const A2 = { ...A, mouthHalf: A.mouthHalf * 1.06, noseLen: A.noseLen * 0.94,
    chinDrop: A.chinDrop * 1.06 };
  const clearSig = faceSignature(mesh(A2));
  check('the gated head is the better match, so the contest is real', (() => {
    const t = m7.matchAll(turnedSig)[0], c = m7.matchAll(clearSig)[0];
    return t.inside && c.inside && c.dist - t.dist > 0.02;
  })(), true);
  const contest = assignFaces([turnedSig, clearSig], m7, [flagged, null]);
  check('a clear head keeps the name a gated head would otherwise claim', (() => {
    const named = contest.filter((r) => r.id);
    return named.length === 1 && named[0].index === 1 && named[0].gated === false;
  })(), true);
  check('with no flag the same contest hands the name to the closer match', (() => {
    const plain = assignFaces([turnedSig, clearSig], m7, [null, null]);
    return plain[0].id === 'hs1' && !plain[1].id;
  })(), true);
  const alone = assignFaces([turnedSig], m7, [flagged]);
  check('a gated head keeps an uncontested name, flagged', [alone[0].id, alone[0].gated],
    (a) => a[0] === 'hs1' && a[1] === true);
  check('no gates array means the old behaviour, nothing flagged',
    assignFaces([faceSignature(mesh(A, -0.16))], m7)[0].gated, false);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
