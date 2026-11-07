// How much does scoring a SECOND head in the same frame cost? The landmark pass already returns every
// head, so this measures only the pure-math pipeline: MonitorSession.process on a synthetic 478-point
// mesh. Run with the bundled Node.
import { MonitorSession } from
  '../dist/js/session.mjs';

// The same parametric face test-identity.mjs uses, because a generic ellipse never calibrates and the
// session then short-circuits - which would measure the bail-out path, not the pipeline.
const P = { eyeHalf: 0.08, noseLen: 0.052, mouthDrop: 0.075, mouthHalf: 0.056, chinDrop: 0.055,
  jawHalf: 0.105, cheekHalf: 0.092, browHalf: 0.076, wingHalf: 0.023 };
function mesh(p, ox = 0, oy = 0, k = 1) {
  const pts = new Array(478).fill(null).map((_, i) => {
    const a = (i / 478) * Math.PI * 2;
    return { x: 0.5 + 0.16 * Math.cos(a), y: 0.5 + 0.2 * Math.sin(a), z: 0 };
  });
  const at = (i, x, y) => { pts[i] = { x: (x - 0.5) * k + 0.5 + ox, y: (y - 0.5) * k + 0.5 + oy, z: 0 }; };
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
const blend = { faceBlendshapes: [{ score: 0.2, categories: [
  { categoryName: 'eyeBlinkLeft', score: 0.05 }, { categoryName: 'eyeBlinkRight', score: 0.05 },
  { categoryName: 'jawOpen', score: 0.02 }, { categoryName: 'browInnerUp', score: 0.1 },
] }] };

const s = new MonitorSession();
s.setFrameSize(640, 480);
const pts = mesh(P);
let t = 0;
for (let i = 0; i < 30; i++) { t += 33; s.process(pts, blend, t, 120, {}); }   // warm up
const N = 300;
const t0 = performance.now();
let out = null;
for (let i = 0; i < N; i++) { t += 33; out = s.process(pts, blend, t, 120, {}); }
const ms = (performance.now() - t0) / N;
console.log('calibrated=' + s.calibrated + ' calFrames=' + s.calFrames + ' reliable=' + (out.reliable !== undefined ? out.reliable : '?'));
console.log('process() per head: ' + ms.toFixed(3) + ' ms  (sei=' + out.sei + ', alert=' + out.alertCode + ')');
console.log('so with the measured FaceLandmarker pass (11.9 ms) and a 33 ms frame budget: '
  + '2 heads = ' + (2 * ms).toFixed(2) + ' ms of math');
