// Times the shipped decodeYolo over a synthetic (1,84,8400) tensor. Run before and after the class
// list changes; the only variable is YOLO_CLASSES.length.
import { decodeYolo, letterboxPlan, YOLO_CLASSES } from
  '../dist/js/yolo.mjs';
const A = 8400, S = A, n = 84 * A;
const out = new Float32Array(n);
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < n; i++) out[i] = rnd() * 0.05;      // noise below the 0.35 bar
for (let k = 0; k < YOLO_CLASSES.length; k++) {          // one live box per class
  const i = 100 + k * 7;
  out[(4 + YOLO_CLASSES[k][0]) * S + i] = 0.9;
  out[i] = 320; out[S + i] = 240; out[2 * S + i] = 80; out[3 * S + i] = 120;
}
const plan = letterboxPlan(640, 480);
decodeYolo(out, plan, 640, 480);
const t0 = performance.now();
const R = 50;
let got = 0;
for (let r = 0; r < R; r++) got += decodeYolo(out, plan, 640, 480).detections.length;
const ms = (performance.now() - t0) / R;
console.log('classes=' + YOLO_CLASSES.length + ' detections/pass=' + (got / R)
  + ' decode=' + ms.toFixed(2) + ' ms');
