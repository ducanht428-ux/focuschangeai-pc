// Scratch: does the shipped build accept a bank written by an older build (and reject a bad one)?
import { FaceMatcher, faceSignature }
  from '../dist/js/identity.mjs';

const P = { eyeHalf: 0.08, noseLen: 0.052, mouthDrop: 0.075, mouthHalf: 0.056, chinDrop: 0.055,
  jawHalf: 0.105, cheekHalf: 0.092, browHalf: 0.076, wingHalf: 0.023 };
function mesh(p) {
  const pts = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  const set = (i, x, y) => { pts[i] = { x, y }; };
  const cx = 0.5, ey = 0.45, r = p.eyeHalf * 0.25, ty = ey + p.noseLen, my = ey + p.mouthDrop;
  set(33, cx - p.eyeHalf - r, ey); set(133, cx - p.eyeHalf + r, ey);
  set(159, cx - p.eyeHalf, ey - r * 0.7); set(145, cx - p.eyeHalf, ey + r * 0.7);
  set(362, cx + p.eyeHalf + r, ey); set(263, cx + p.eyeHalf - r, ey);
  set(386, cx + p.eyeHalf, ey - r * 0.7); set(374, cx + p.eyeHalf, ey + r * 0.7);
  set(4, cx, ey); set(6, cx, ey + p.noseLen * 0.55); set(1, cx, ty); set(2, cx, ty + 0.01);
  set(98, cx - p.wingHalf, ty + 0.005); set(327, cx + p.wingHalf, ty + 0.005);
  set(61, cx - p.mouthHalf, my); set(291, cx + p.mouthHalf, my); set(152, cx, my + p.chinDrop);
  set(234, cx - p.jawHalf, my); set(454, cx + p.jawHalf, my);
  set(50, cx - p.cheekHalf, ey + 0.07); set(280, cx + p.cheekHalf, ey + 0.07);
  set(116, cx - p.cheekHalf * 0.8, ey + 0.1); set(345, cx + p.cheekHalf * 0.8, ey + 0.1);
  set(107, cx - p.browHalf, ey - 0.035); set(336, cx + p.browHalf, ey - 0.035);
  return pts;
}
const sig = faceSignature(mesh(P));
console.log('signature dimensions:', sig.length);

const m = new FaceMatcher();
console.log('stored in this build:', m.addSample('x', sig), ' radius:', m.radius('x').toFixed(3));

// A bank as localStorage would hand it back after an upgrade: same length, so it must load.
const m2 = new FaceMatcher();
m2.setBank({ x: [sig, sig.map((v) => v + 0.001)] });
console.log('legacy same-length bank loads:', m2.count('x'), ' match dist:',
  m2.match(sig).dist.toFixed(4));

// A bank from a build with a different signature must be refused, not silently compared.
const m3 = new FaceMatcher();
m3.setBank({ x: [sig.slice(0, sig.length - 1)] });
console.log('different-length bank kept?', m3.count('x'), '(0 means correctly dropped)');
console.log('matching against it declines:', m3.match(sig));

// Garbage that localStorage can contain after a partial write.
const m4 = new FaceMatcher();
m4.setBank({ x: [[NaN, 1, 2, 3], ['a']], y: [] });
console.log('non-finite / non-array samples:', m4.count('x'), m4.match(sig));
