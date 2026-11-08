// Layer 1 alternative: the same YOLO11n the Python window runs, decoded inside the tab.
//
// Why this file exists at all: efficientdet_lite0 sees the frame at 320 pixels while config.yaml:62
// runs YOLO at imgsz 640, so a student in a back row is half the size here as on the camera window.
// This engine removes that difference - same weights, same 640, same 0.35 confidence bar.
//
// What it costs, measured on the operator's own laptop (i5-5200U) on 2026-11-04 rather than guessed:
//   wasm/CPU   session boot 103 s, then 1188-1368 ms per pass
//   WebGPU     session boot 12.7 s, first pass never returned (Intel gen-8, hung > 5 min)
//   lite0      boots under 1 s, 130 ms per pass
// So this engine is loaded in the BACKGROUND and only takes over once a real pass has come back in
// time; a machine that hangs keeps lite0 and keeps a working page. loadYoloEngine() enforces that.
//
// The output shape is deliberately MediaPipe's own shape - {detections: [{boundingBox, categories}]} -
// because detect.mjs's readBoxes() already consumes it, so every rule downstream (context-object
// ownership, track numbers, colours, plates) is shared with the lite0 path instead of duplicated.

import { DETECT_CONF, DETECT_MAX_RESULTS } from './detect.mjs';

export const YOLO_SIZE = 640;
export const YOLO_NMS_IOU = 0.45;
export const YOLO_PAD = 114;

// The COCO classes this project draws, spelled by id because the graph outputs rows, not names.
// detection.py:19-24 keeps person 0 plus four context objects; js/detect.mjs's CONTEXT_VI now names forty,
// so the two legs no longer hold the same list - that gap is written down in detect.mjs rather than
// hidden. test-objects.mjs still fails if the two files disagree about an id, because the adjacent rows
// bottle 39 / wine glass 40 / cup 41 are exactly where a typo would go unnoticed: the wrong row still
// produces a confident box, just a mislabelled one.
// Growing this list is cheap and was measured, not assumed: the pass scores all 84 rows either way
// (Ultralytics output), and the only thing that scales with the list is the decode loop below. Re-run of
// bench-yolo-decode.mjs on this laptop after the growth to 41 rows: 3.0 ms per frame, all 41 boxes kept,
// against the 1,188-1,368 ms pass recorded at the top of this file - a fifth of one percent. Furniture is
// still absent for the reason in detect.mjs.
// Break-time reality moved the list from sixteen to forty-one rows: a lunchbox and a fruit are what a
// Vietnamese primary-school desk actually holds, and every one of these rows was already scored by the
// shipped weights, so the only cost is the decode loop above. Skis, snowboard, surfboard, vehicles,
// animals, street furniture and kitchen appliances are still out - not because they are expensive but
// because a box labelled "ván trượt tuyết" in a Hanoi classroom would read as a bug to the operator.
export const YOLO_CLASSES = [
  [0, 'person'],
  // bags, screens, time
  [24, 'backpack'], [26, 'handbag'], [63, 'laptop'], [67, 'cell phone'], [64, 'mouse'],
  [66, 'keyboard'], [65, 'remote'], [74, 'clock'], [62, 'tv'],
  // reading and playing
  [73, 'book'], [76, 'scissors'], [77, 'teddy bear'], [25, 'umbrella'], [32, 'sports ball'],
  [29, 'frisbee'], [33, 'kite'], [34, 'baseball bat'], [35, 'baseball glove'],
  [36, 'skateboard'], [38, 'tennis racket'],
  // drink and tableware
  [39, 'bottle'], [41, 'cup'], [40, 'wine glass'], [42, 'fork'], [43, 'knife'], [44, 'spoon'],
  [45, 'bowl'],
  // food
  [46, 'banana'], [47, 'apple'], [48, 'sandwich'], [49, 'orange'], [50, 'broccoli'], [51, 'carrot'],
  [52, 'hot dog'], [53, 'pizza'], [54, 'donut'], [55, 'cake'],
  // worn and planted
  [27, 'tie'], [58, 'potted plant'], [75, 'vase'],
];

// Ultralytics 8.4 export was measured on this machine: the class rows are already sigmoid-applied
// (max 0.0067 on random noise, nothing above 1.0) and the four box rows are pixel coordinates in the
// 640 space. So no sigmoid and no anchor decoding here - only centre-to-corner and the letterbox undo.
const ANCHORS = 8400;
const STRIDE = ANCHORS; // out[c * STRIDE + i], the (1, 84, 8400) layout

/** The scale-and-pad plan that maps a camera frame into the square the model eats. */
export function letterboxPlan(frameW, frameH, size = YOLO_SIZE) {
  const scale = Math.min(size / frameW, size / frameH);
  const nw = Math.round(frameW * scale);
  const nh = Math.round(frameH * scale);
  return { scale, nw, nh, padX: Math.floor((size - nw) / 2), padY: Math.floor((size - nh) / 2) };
}

/**
 * RGBA (0..255, row-major, size*size) to the float32 NCHW tensor the ONNX graph asks for.
 *
 * Written as an explicit three-plane copy because the browser hands back interleaved pixels and the
 * graph wants BCHW-with-C-first: getting that order wrong still produces a number, just a meaningless
 * one, which is why this is a separate exported function with its own test.
 */
export function rgbaToNchw(rgba, size = YOLO_SIZE) {
  const area = size * size;
  const out = new Float32Array(3 * area);
  for (let i = 0, p = 0; i < area; i++, p += 4) {
    out[i] = rgba[p] / 255;
    out[area + i] = rgba[p + 1] / 255;
    out[2 * area + i] = rgba[p + 2] / 255;
  }
  return out;
}

function iouOf(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
}

/** Per-class suppression, the way Ultralytics runs it: a phone is never suppressed by a person. */
export function nmsPerClass(cands, thr = YOLO_NMS_IOU) {
  const byClass = new Map();
  for (const c of cands) {
    const list = byClass.get(c.cls);
    if (list) list.push(c); else byClass.set(c.cls, [c]);
  }
  const kept = [];
  for (const list of byClass.values()) {
    list.sort((a, b) => b.score - a.score);
    const keep = [];
    // Greedy, against the boxes already accepted - not against every candidate. Compared against the
    // full list, two overlapping students each veto the other and both disappear, which is what an
    // earlier draft of this loop did and what _dev/yolo-check.mjs now pins.
    for (const c of list) {
      if (keep.every((k) => iouOf(c, k) <= thr)) keep.push(c);
    }
    kept.push(...keep);
  }
  kept.sort((a, b) => b.score - a.score);
  return kept;
}

/**
 * Turn one (1, 84, 8400) tensor into MediaPipe-shaped detections in FRAME pixels.
 *
 * @param {Float32Array} out  flat model output, out[c * 8400 + i]
 * @param {object} plan       letterboxPlan() for the frame this tensor was made from
 * @param {number} frameW     camera width in pixels, the space the overlay draws in
 * @param {number} frameH
 */
export function decodeYolo(out, plan, frameW, frameH, conf = DETECT_CONF, maxResults = DETECT_MAX_RESULTS) {
  const cands = [];
  for (let i = 0; i < ANCHORS; i++) {
    let best = -1;
    let bestScore = conf;
    for (let k = 0; k < YOLO_CLASSES.length; k++) {
      const s = out[YOLO_CLASSES[k][0] * STRIDE + i + 4 * STRIDE];
      if (s > bestScore) { bestScore = s; best = k; }
    }
    if (best < 0) continue;
    const cx = out[i];
    const cy = out[STRIDE + i];
    const bw = out[2 * STRIDE + i];
    const bh = out[3 * STRIDE + i];
    if (!(bw > 0 && bh > 0)) continue;
    // Undo the letterbox, then clip to the frame - Ultralytics clips too, and an unclipped box would
    // let a plate run outside the camera band into the numbers column.
    const toFrame = (v, pad, scale, limit) => Math.min(Math.max((v - pad) / scale, 0), limit);
    const x0 = toFrame(cx - bw / 2, plan.padX, plan.scale, frameW);
    const y0 = toFrame(cy - bh / 2, plan.padY, plan.scale, frameH);
    const x1 = toFrame(cx + bw / 2, plan.padX, plan.scale, frameW);
    const y1 = toFrame(cy + bh / 2, plan.padY, plan.scale, frameH);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    cands.push({ cls: YOLO_CLASSES[best][0], name: YOLO_CLASSES[best][1], score: bestScore, x0, y0, x1, y1 });
  }
  const kept = nmsPerClass(cands).slice(0, maxResults);
  return {
    detections: kept.map((c) => ({
      boundingBox: { originX: c.x0, originY: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0 },
      categories: [{ categoryName: c.name, score: c.score }],
    })),
  };
}

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' qua ' + ms + ' ms')), ms)),
]);

/**
 * Build a YOLO engine, or null if this machine cannot run one in time.
 *
 * Two clocks, because they fail differently: the boot clock is generous (a slow machine that finishes
 * in 60 s is still a machine that works) while the first-pass clock is strict, and the first pass is
 * the one that hung forever on this laptop's WebGPU.
 */
export async function loadYoloEngine(ort, opts) {
  const {
    modelPath = './yolo11n.onnx',
    wasmPaths = './wasm-ort/',
    bootMs = 180000,
    probeMs = 10000,
    proxy = true,
    log = () => {},
  } = opts || {};
  // Resolved against THIS document, once, at the top: the model is fetched relative to the page but the
  // wasm loader is fetched relative to ort.min.js's own URL, and those two differ as soon as the library
  // sits in the folder it points at (./wasm-ort/ort.min.js + wasmPaths './wasm-ort/' = /wasm-ort/wasm-ort/,
  // which is the "Failed to fetch dynamically imported module" this line removes). Absolute URLs make the
  // engine load the same from /index.html and from /_dev/anything.html.
  const modelUrl = new URL(modelPath, document.baseURI).href;
  const wasmUrl = new URL(wasmPaths, document.baseURI).href;
  ort.env.wasm.wasmPaths = wasmUrl;
  // The bench that measured 1.2-1.4 s per pass ran one thread, because a plain http:// page has no
  // crossOriginIsolated and therefore no SharedArrayBuffer. Asking for four threads here would be a
  // different, untested configuration - so the threads only come on when the browser really grants them.
  ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.logLevel = 'error';

  // wasm first. Not a preference but a measured order: on the operator's laptop a WebGPU pass never came
  // back (10 s probe here, >5 min in _dev/yolo-bench-gpu.html), and abandoning that session then broke
  // the retry with ORT's own "Session already started". A machine with a working GPU still gets WebGPU -
  // only after the path that is proven here has had its turn. The provider is named explicitly because
  // leaving it out lets ORT pick its own fallback list, which on this machine is not the one measured.
  const eps = ['wasm'];
  if (navigator.gpu) eps.push('webgpu');
  // ONE mode per page, chosen before the first session is created. Measured in _dev/yolo-proxy-bench.html
  // on 2026-11-05, on this host, with this exact vendored ort build:
  //   proxy=true  session boots in 2.3 s, passes 1585/1206/610 ms, and the main thread's own timer chain
  //               kept ticking through all three - the tab paints while a pass runs.
  //   proxy=false passes 1189/1076/1097 ms and the timer chain got ZERO ticks across 3.4 s of passes -
  //               the main thread was frozen solid for every one of them. That freeze is the lag.
  // So the worker is the default. But trying both in one page is not a fallback, it is a trap: after a
  // proxy session exists, the next non-proxy create fails with ORT's own "WebAssembly is not initialized
  // yet", which would leave the operator with neither engine. A machine that really needs the old
  // behaviour asks for it once, with ?yoloproxy=0, and gets a clean page in that mode.
  for (const ep of eps) {
    const where = proxy ? ep + '+worker' : ep;
    let session = null;
    try {
      ort.env.wasm.proxy = proxy;
      const t0 = performance.now();
      session = await withTimeout(ort.InferenceSession.create(modelUrl,
        { executionProviders: [ep] }), bootMs, 'tai YOLO ' + where);
      log('  YOLO ' + where + ' nap xong (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s), do luot dau...');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = YOLO_SIZE;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const engine = new YoloEngine({ ort, session, canvas, ctx, log, thread: where });
      const probe = document.createElement('canvas');
      probe.width = 64; probe.height = 48;
      const pctx = probe.getContext('2d');
      pctx.fillStyle = 'rgb(' + YOLO_PAD + ',' + YOLO_PAD + ',' + YOLO_PAD + ')';
      pctx.fillRect(0, 0, 64, 48);
      // Timed here rather than left to detectForVideo(), which only records the passes the loop asks for:
      // printing engine.lastMs before the first of those would show 0 ms, and a 0 ms YOLO number would be
      // a lie about the machine the operator is standing in front of.
      const tp = performance.now();
      await withTimeout(engine.runOn(probe, 64, 48), probeMs, 'luot dau ' + where);
      engine.lastMs = performance.now() - tp;
      log('  YOLO ' + where + ' OK: ' + engine.lastMs.toFixed(0) + ' ms mot luot 640x640.');
      return engine;
    } catch (e) {
      log('  YOLO ' + where + ' bo: ' + String(e.message).slice(0, 80));
      if (session && session.release) { try { await session.release(); } catch (ignored) {} }
    }
  }
  return null;
}

/** Same call surface as MediaPipe's ObjectDetector, so index.html needs no second code path. */
export class YoloEngine {
  constructor({ ort, session, canvas, ctx, log, thread }) {
    this.ort = ort; this.session = session;
    this.canvas = canvas; this.ctx = ctx;
    this.log = log;
    // Which thread the compute really lands on, for the P line: 'wasm+worker' means the tab stayed free
    // during a pass, 'wasm' means it did not.
    this.thread = thread || 'wasm';
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
    this.lastMs = 0;
    this.kind = 'yolo';
  }

  runOn(source, srcW, srcH) {
    const plan = letterboxPlan(srcW, srcH);
    const c = this.ctx;
    c.fillStyle = 'rgb(' + YOLO_PAD + ',' + YOLO_PAD + ',' + YOLO_PAD + ')';
    c.fillRect(0, 0, YOLO_SIZE, YOLO_SIZE);
    c.drawImage(source, plan.padX, plan.padY, plan.nw, plan.nh);
    const img = c.getImageData(0, 0, YOLO_SIZE, YOLO_SIZE);
    const tensor = new this.ort.Tensor('float32', rgbaToNchw(img.data),
      [1, 3, YOLO_SIZE, YOLO_SIZE]);
    return this.session.run({ [this.inputName]: tensor }).then((res) =>
      decodeYolo(res[this.outputName].data, plan, srcW, srcH));
  }

  /** @param {HTMLVideoElement} video   @param {number} t   timestamp, ignored - kept for the shared surface */
  detectForVideo(video, t) {
    const t0 = performance.now();
    const out = this.runOn(video, video.videoWidth, video.videoHeight);
    // The loop calls this synchronously, so the timing is recorded on the next microtask; the number
    // shown in the footer is the previous pass. One pass per cadence tick makes that harmless, and it
    // keeps this leg's footer honest about what it actually measured.
    return out.then((r) => { this.lastMs = performance.now() - t0; return r; })
      .catch((e) => { this.log('YOLO luot do loi: ' + String(e.message).slice(0, 80)); return { detections: [] }; });
  }

  close() { if (this.session && this.session.release) this.session.release(); }
}
