// Calibration probe for the identity gate - not shipped, run with the bundled Node.
//
// The gate has to refuse a frame before its 20 numbers are used for a name, so the thresholds must be
// numbers with a meaning: this file prints, for a synthetic head rotated by a known yaw, both candidate
// gate measures (the mouth/nose asymmetry and the nose shift) and the damage the pose actually does to
// the signature. Pick the threshold where the damage crosses the gap between two students.
import { faceSignature } from
  '../dist/js/identity.mjs';

// Same parametric face as test-identity.mjs, but with a yaw applied: a plane turned by theta compresses
// its x by cos(theta), its projected centre walks toward the near side, and the nose - the only point
// standing proud of the plane - walks further. z of the nose tip in MediaPipe units is about 0.06 of the
// face width, which is where the extra lateral shift comes from.
function meshY(p, yawDeg, ox = 0, oy = 0, k = 1) {
  const th = (yawDeg * Math.PI) / 180;
  const c = Math.cos(th);
  const pts = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  const at = (i, x, y, z = 0) => {
    const dx = (x - 0.5) * c + Math.sin(th) * z * 1.0;
    pts[i] = { x: ((0.5 + dx) - 0.5) * k + 0.5 + ox, y: ((y - 0.5) * k + 0.5 + oy) };
  };
  const eyeY = 0.45;
  const eL = { x: 0.5 - p.eyeHalf, y: eyeY }, eR = { x: 0.5 + p.eyeHalf, y: eyeY };
  const r = p.eyeHalf * 0.25;
  at(33, eL.x - r, eL.y, -0.01); at(133, eL.x + r, eL.y, -0.01);
  at(159, eL.x, eL.y - r * 0.7, 0); at(145, eL.x, eL.y + r * 0.7, -0.005);
  at(362, eR.x + r, eR.y, -0.01); at(263, eR.x - r, eR.y, -0.01);
  at(386, eR.x, eR.y - r * 0.7, 0); at(374, eR.x, eR.y + r * 0.7, -0.005);
  const tipY = eyeY + p.noseLen;
  at(4, 0.5, eyeY, 0.02); at(6, 0.5, eyeY + p.noseLen * 0.55, 0.04);
  at(1, 0.5, tipY, 0.075); at(2, 0.5, tipY + 0.01, 0.055);
  at(98, 0.5 - p.wingHalf, tipY + 0.005, 0.03); at(327, 0.5 + p.wingHalf, tipY + 0.005, 0.03);
  const mouthY = eyeY + p.mouthDrop;
  at(61, 0.5 - p.mouthHalf, mouthY, 0.01); at(291, 0.5 + p.mouthHalf, mouthY, 0.01);
  const chinY = mouthY + p.chinDrop;
  at(152, 0.5, chinY, 0.02);
  at(234, 0.5 - p.jawHalf, mouthY, -0.02); at(454, 0.5 + p.jawHalf, mouthY, -0.02);
  at(50, 0.5 - p.cheekHalf, eyeY + 0.07, -0.03); at(280, 0.5 + p.cheekHalf, eyeY + 0.07, -0.03);
  at(116, 0.5 - p.cheekHalf * 0.8, eyeY + 0.1, -0.02); at(345, 0.5 + p.cheekHalf * 0.8, eyeY + 0.1, -0.02);
  at(107, 0.5 - p.browHalf, eyeY - 0.035, -0.01); at(336, 0.5 + p.browHalf, eyeY - 0.035, -0.01);
  return pts;
}

const A = { eyeHalf: 0.08, noseLen: 0.052, mouthDrop: 0.075, mouthHalf: 0.056, chinDrop: 0.055,
  jawHalf: 0.105, cheekHalf: 0.092, browHalf: 0.076, wingHalf: 0.023 };
const B = { eyeHalf: 0.078, noseLen: 0.066, mouthDrop: 0.068, mouthHalf: 0.046, chinDrop: 0.062,
  jawHalf: 0.118, cheekHalf: 0.081, browHalf: 0.064, wingHalf: 0.029 };
const C3 = { eyeHalf: 0.095, noseLen: 0.038, mouthDrop: 0.092, mouthHalf: 0.071, chinDrop: 0.041,
  jawHalf: 0.088, cheekHalf: 0.101, browHalf: 0.09, wingHalf: 0.019 };

const s0 = faceSignature(meshY(A, 0));
const d = (u, v) => Math.hypot(...u.map((x, i) => x - v[i]));
// The gap between two strangers sitting straight-on - the scale the gate damage has to be judged against.
const gaps = [d(s0, faceSignature(meshY(B, 0))), d(s0, faceSignature(meshY(C3, 0))),
  d(faceSignature(meshY(B, 0)), faceSignature(meshY(C3, 0)))];
console.log('straight-on distance between two different synthetic faces: '
  + gaps.map((g) => g.toFixed(3)).join(' / ') + ' (smallest ' + Math.min(...gaps).toFixed(3) + ')');

const asym = (pts) => {
  const tip = pts[1], mL = pts[61], mR = pts[291];
  const tl = Math.hypot(tip.x - mL.x, tip.y - mL.y), tr = Math.hypot(tip.x - mR.x, tip.y - mR.y);
  return (tr - tl) / (tr + tl);
};
const shift = (pts) => {
  const a = pts[33], b = pts[133], c = pts[159], e = pts[145];
  const f = pts[362], g = pts[263], h = pts[386], i = pts[374];
  const L = { x: (a.x + b.x + c.x + e.x) / 4, y: (a.y + b.y + c.y + e.y) / 4 };
  const R = { x: (f.x + g.x + h.x + i.x) / 4, y: (f.y + g.y + h.y + i.y) / 4 };
  const D = Math.hypot(L.x - R.x, L.y - R.y);
  return Math.abs(pts[1].x - (L.x + R.x) / 2) / D;
};

console.log('\nyaw   asym    |shift|/D   sig-dist-from-straight   % of smallest gap   jitter-noise(0.004)=');
const noise = (() => {
  let s = 0;
  for (let i = 0; i < 60; i++) {
    const o = {};
    for (const k of Object.keys(A)) o[k] = A[k] + (Math.random() * 2 - 1) * 0.004;
    s += d(s0, faceSignature(meshY(o, 0)));
  }
  return s / 60;
})();
for (const deg of [0, 5, 10, 15, 20, 25, 30, 40]) {
  const pts = meshY(A, deg);
  const sig = faceSignature(pts);
  const dd = sig ? d(s0, sig) : NaN;
  console.log(String(deg).padStart(3) + '  ' + asym(pts).toFixed(4).padStart(7) + '  '
    + shift(pts).toFixed(4).padStart(7) + '   ' + (Number.isFinite(dd) ? dd.toFixed(4) : ' null   ')
    + '        ' + (Number.isFinite(dd) ? ((100 * dd) / Math.min(...gaps)).toFixed(0) + '%' : '-')
    + '   (1 sigma per dim of mesh noise = ' + noise.toFixed(4) + ')');
}
