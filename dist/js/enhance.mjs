// Low-light image enhancement for the browser leg, ported from the phone's own stage so the two
// machines lift a dark classroom the same way: EyeEngine.kt:494-956 (internal class ImageEnhancer).
//
// What the phone does and what is kept here, item by item:
//   1. Measures the real light over the face region and over the whole frame (brightness, contrast,
//      blown-pixel ratio). On the phone that reads the camera's Y plane; here it reads the canvas'
//      RGBA pixels through measureLight, so the numbers are BT.601 luma rather than the sensor's Y.
//   2. A controller with hysteresis and a minimum hold time, so the picture never flickers and the
//      calibration baseline never sees a step. Same ON/OFF thresholds, same 4 s hold.
//   3. CLAHE (contrast-limited adaptive histogram equalisation) over the region: per-tile histogram,
//      clipped threshold, redistributed remainder, bilinear interpolation between the 4 neighbouring
//      tiles - the same integer arithmetic as the Kotlin, which was itself cross-checked against
//      OpenCV to within one gray level.
//   4. A separable 3x3 Gaussian only when badly underexposed, because CLAHE amplifies noise.
//   5. The same self-imposed budget: when the average cost per enhanced frame goes over BUDGET_MS the
//      stage pauses itself for 30 s rather than dragging the frame rate down.
//
// The one structural difference, and it is a real one: the phone edits the Y plane in place and the
// encoder recombines it with the untouched chrominance. The browser only ever holds RGBA, so this
// builds a luma plane for the region, runs the two kernels on it, then adds the resulting
// per-pixel delta back onto R, G and B. Chrominance is preserved exactly as it is on the phone, and
// the pixels the landmark model sees are the same brightness map.
//
// The one thing this leg does that the phone does not: the very-dark gain band at the bottom of this
// file. The frozen app never touches the camera's exposure (no CONTROL_AE or brightness call anywhere
// in app/src/main/java), and a browser cannot either - _dev/exposure-probe2.js tried every picture
// control the Logitech C270 reports and all of them throw UnknownError, only frameRate is honoured. So
// on this machine the lift has to happen in pixels. It is gated to frames the quality score already
// reports as "Ánh sáng quá yếu" and is named in the page's own footer, never in the phone's sentence.

export const TILES_ROI = 4;
export const TILES_FULL = 8;
export const CLIP_LIMIT = 2.5;
export const ON_MEAN = 85;
export const OFF_MEAN = 105;
export const ON_STD = 28;
export const OFF_STD = 36;
export const DENOISE_MEAN = 65;
export const MIN_TOGGLE_MS = 4000;
export const BUDGET_MS = 12;
export const BUDGET_WARMUP_FRAMES = 30;
export const PAUSE_MS = 30000;
export const MIN_REGION = 64;
export const SNAP = 8;

// The very-dark band, and the one place this leg does MORE than the phone.
//
// _dev/dark-rescue-probe.js fed three faces darkened to four levels to the real FaceLandmarker and
// scored each variant by how far the two eye blendshapes sat from the well-lit answer (dEye, 1/100 of a
// blendshape point). At the two levels this band covers, the phone's CLAHE alone was not enough - it
// was worse than doing nothing (dEye 5.50 vs 3.57 at mean 13.5, 6.57 vs 4.07 at mean 24.3), because
// equalising a histogram with almost no counts in it invents contrast. Multiplying R, G and B toward a
// modest target first put real counts into the tiles, and then the same CLAHE had something to work on:
// 3.57 at mean 13.5 and 3.00 at mean 24.3 with target 70, which beat 80 and 90 at every level.
//
// Target 70, not 110: round 1 of the same probe pushed a merely dim frame (mean 63) up to 110 and made
// it worse (dEye 1.9 vs 0.2). So the band is gated to the frames the app already calls badly lit, and
// the factor is capped so a near-black frame is not blown up into eight times its own noise.
//
// The cap was then argued against 12, 16 and no cap at all, on the hardest case there is - a window behind
// the student, face crushed to 1-2 grey levels (_dev/backlit-ceiling-probe.js, full table in
// _dev/backlit-ceiling-result.txt). Every cap recovered the FACE (15/15 against 6/15 raw), so the limit is
// not the multiply; the eye blendshapes stayed 5.7-21.9/100 wrong at mean 2 at every cap, while the
// aggregate moved no more than the three faces' spread, and a cap over 8 pushed the mean-5 frames to 103-109
// where 8 already produced a usable 82. Eight stays, because nothing above it is a result rather than a guess.
export const BOOST_TARGET_MEAN = 70;
export const BOOST_MAX_FACTOR = 8;
// Deliberately the same number as measure.mjs LUMA_VERY_LOW - the threshold at which
// computeSignalQuality prints "Ánh sáng quá yếu". This band exists to answer that exact warning, so it
// has to fire on exactly the frames that raise it. enhance-check.mjs pins the two together.
export const BOOST_BELOW_MEAN = 35;
// Once engaged, the band holds until the face mean clears this, and the factor itself is approached rather
// than jumped to. Two separate measured problems, and _dev/enhance-check.mjs pins each with its own
// mutation, because each fix only answers one of them:
//   - _dev/band-flicker.mjs drives a mean that wobbles 34.4 / 35.6 / 34.4, which is what sparse sampling of
//     a moving picture in a dim room actually produces. Against a single threshold of 35 that swung the
//     frame the model reads by 47.8 gray levels every other frame. The LATCH is what fixes it (to 1.6);
//     the ramp alone only smooths it to 2.1 and still loses the band entirely in a room at 40.
//   - the lamp coming on mid-session, which opens the latch and would take the whole gain away in ONE
//     frame: 47.0 gray levels at once. That is what BOOST_FALL is for, and it walks down by 7.4 instead.
// A step is what a blink detector mistakes for a blink, and it is exactly the thing decide()'s hysteresis
// and 4 s hold were built to avoid on the phone.
export const BOOST_OFF_MEAN = 45;
export const BOOST_RISE = 0.5;
export const BOOST_FALL = 0.15;

// The phone's clock is a wall clock that is never near zero, so the hold time in MIN_TOGGLE_MS never
// blocks its first decision. performance.now() starts at 0 in a browser tab, which would lock the
// stage out of the first four seconds of every session - so the clock starts one hold time in the past.
const FIRST_TOGGLE_FREE = -MIN_TOGGLE_MS;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * EyeEngine.kt:634-658 mapRoi, minus the sensor-rotation step: the canvas is already upright.
 * The box is rounded onto an 8-pixel grid so the region does not jitter from frame to frame, and a
 * region under 64 px on either axis is refused, which sends the phone - and this - to the whole
 * frame instead.
 */
export function snapRoi(box, width, height) {
  if (!box) return null;
  const x0 = clamp(Math.trunc(box.x0 / SNAP) * SNAP, 0, width);
  const y0 = clamp(Math.trunc(box.y0 / SNAP) * SNAP, 0, height);
  const x1 = clamp(Math.trunc((box.x1 + SNAP - 1) / SNAP) * SNAP, 0, width);
  const y1 = clamp(Math.trunc((box.y1 + SNAP - 1) / SNAP) * SNAP, 0, height);
  if (x1 - x0 < MIN_REGION || y1 - y0 < MIN_REGION) return null;
  return { x0, y0, x1, y1 };
}

/**
 * EyeEngine.kt:757-783 buildAxis: for every pixel index along one axis, the two neighbouring tiles,
 * the blend weight on a 256 scale, and the tile that pixel belongs to.
 */
function buildAxis(n, tiles, i0, i1, wt, tileOf) {
  for (let p = 0; p < n; p++) {
    const f = (p + 0.5) * tiles / n - 0.5;
    if (f <= 0) {
      i0[p] = 0; i1[p] = 0; wt[p] = 0;
    } else if (f >= tiles - 1) {
      i0[p] = tiles - 1; i1[p] = tiles - 1; wt[p] = 0;
    } else {
      const a = Math.trunc(f);
      i0[p] = a;
      i1[p] = a + 1;
      wt[p] = clamp(Math.trunc((f - a) * 256), 0, 256);
    }
    tileOf[p] = Math.min(tiles - 1, Math.trunc(p * tiles / n));
  }
}

/**
 * EyeEngine.kt:789-897 clahe, over a contiguous luma plane instead of a strided Y plane.
 * The arithmetic is copied line for line: truncate the clip count, add the even remainder back,
 * walk the leftover out in steps, then take the CDF scaled to 255 and round half up.
 */
export function clahePlane(luma, rw, rh, tilesX, tilesY, clipLimit, s) {
  const nT = tilesX * tilesY;
  if (s.hist.length < nT * 256) {
    s.hist = new Int32Array(nT * 256);
    s.lut = new Int32Array(nT * 256);
  }
  const hist = s.hist;
  const lut = s.lut;
  if (s.colI0.length < rw) {
    s.colI0 = new Int32Array(rw); s.colI1 = new Int32Array(rw);
    s.colW = new Int32Array(rw); s.colT = new Int32Array(rw);
  }
  if (s.rowI0.length < rh) {
    s.rowI0 = new Int32Array(rh); s.rowI1 = new Int32Array(rh);
    s.rowW = new Int32Array(rh); s.rowT = new Int32Array(rh);
  }
  const { colI0, colI1, colW, colT, rowI0, rowI1, rowW, rowT } = s;
  hist.fill(0, 0, nT * 256);

  buildAxis(rw, tilesX, colI0, colI1, colW, colT);
  buildAxis(rh, tilesY, rowI0, rowI1, rowW, rowT);

  for (let row = 0; row < rh; row++) {
    const tRow = rowT[row] * tilesX;
    let idx = row * rw;
    for (let col = 0; col < rw; col++, idx++) hist[(tRow + colT[col]) * 256 + luma[idx]]++;
  }

  for (let t = 0; t < nT; t++) {
    const off = t * 256;
    let total = 0;
    for (let i = 0; i < 256; i++) total += hist[off + i];
    if (total === 0) {
      for (let i = 0; i < 256; i++) lut[off + i] = i;
      continue;
    }

    const limit = Math.max(1, Math.trunc(clipLimit * total / 256));
    let excess = 0;
    for (let i = 0; i < 256; i++) {
      const c = hist[off + i];
      if (c > limit) {
        excess += c - limit;
        hist[off + i] = limit;
      }
    }
    const add = Math.trunc(excess / 256);
    let rem = excess - add * 256;
    if (add > 0) for (let i = 0; i < 256; i++) hist[off + i] += add;
    if (rem > 0) {
      const step = Math.max(Math.trunc(256 / rem), 1);
      let i = 0;
      while (i < 256 && rem > 0) { hist[off + i]++; rem--; i += step; }
    }

    const scale = 255 / total;
    let cum = 0;
    for (let i = 0; i < 256; i++) {
      cum += hist[off + i];
      lut[off + i] = clamp(Math.trunc(cum * scale + 0.5), 0, 255);
    }
  }

  for (let row = 0; row < rh; row++) {
    const r0 = rowI0[row] * tilesX;
    const r1 = rowI1[row] * tilesX;
    const wy = rowW[row];
    let idx = row * rw;
    for (let col = 0; col < rw; col++, idx++) {
      const v = luma[idx];
      const wx = colW[col];
      const a = lut[(r0 + colI0[col]) * 256 + v];
      const b = lut[(r0 + colI1[col]) * 256 + v];
      const c = lut[(r1 + colI0[col]) * 256 + v];
      const d = lut[(r1 + colI1[col]) * 256 + v];
      const top = a * (256 - wx) + b * wx;
      const bot = c * (256 - wx) + d * wx;
      luma[idx] = clamp((top * (256 - wy) + bot * wy + 32768) >> 16, 0, 255);
    }
  }
}

/** EyeEngine.kt:900-932 blur3: [1 2 1] on each axis, edges repeated, rounded by (s + 8) >> 4. */
export function blur3Plane(luma, rw, rh, s) {
  if (s.tmp.length < rw * rh) s.tmp = new Int32Array(rw * rh);
  const tmp = s.tmp;

  for (let row = 0; row < rh; row++) {
    const base = row * rw;
    for (let col = 0; col < rw; col++) {
      const l = col > 0 ? col - 1 : 0;
      const r = col < rw - 1 ? col + 1 : rw - 1;
      tmp[base + col] = luma[base + l] + 2 * luma[base + col] + luma[base + r];
    }
  }
  for (let row = 0; row < rh; row++) {
    const u = row > 0 ? row - 1 : 0;
    const d = row < rh - 1 ? row + 1 : rh - 1;
    const base = row * rw;
    for (let col = 0; col < rw; col++) {
      const sum = tmp[u * rw + col] + 2 * tmp[base + col] + tmp[d * rw + col];
      luma[base + col] = (sum + 8) >> 4;
    }
  }
}

/**
 * The controller. It owns the on/off decision, the pause, and the cost estimate - the same three
 * things that make the phone's stage refuse to run rather than eat the frame rate.
 */
export class ImageEnhancer {
  constructor() {
    this.active = false;
    this.denoising = false;
    this.paused = false;
    this.userOff = false;
    this.usingRoi = false;
    this.faceMean = 128;
    this.faceStd = 50;
    this.globalMean = 128;
    this.costMs = 0;
    this.boostOn = false;
    this.boostFactor = 1;
    this.enhancedFrames = 0;
    this.lastToggleMs = FIRST_TOGGLE_FREE;
    this.pausedUntilMs = 0;
    this.scratch = {
      hist: new Int32Array(0), lut: new Int32Array(0), tmp: new Int32Array(0),
      colI0: new Int32Array(0), colI1: new Int32Array(0), colW: new Int32Array(0), colT: new Int32Array(0),
      rowI0: new Int32Array(0), rowI1: new Int32Array(0), rowW: new Int32Array(0), rowT: new Int32Array(0),
    };
    this.luma = new Uint8Array(0);
    this.lumaBefore = new Uint8Array(0);
  }

  reset() {
    this.active = false;
    this.denoising = false;
    this.paused = false;
    this.costMs = 0;
    this.boostOn = false;
    this.boostFactor = 1;
    this.enhancedFrames = 0;
    this.lastToggleMs = FIRST_TOGGLE_FREE;
    this.pausedUntilMs = 0;
  }

  /** EyeEngine.kt:661-671 decide - two separate thresholds and a hold time, so nothing flickers. */
  decide(nowMs, mean, std) {
    const need = this.active
      ? !(mean > OFF_MEAN && std > OFF_STD)
      : mean < ON_MEAN || std < ON_STD;
    if (need !== this.active && nowMs - this.lastToggleMs >= MIN_TOGGLE_MS) {
      this.active = need;
      this.lastToggleMs = nowMs;
    }
  }

  /**
   * Enhances one frame in place and says whether the pixels changed.
   *
   * `light` must be the measurement of the RAW frame (readLight before any editing), because the
   * quality score is supposed to report how lit the room is, not how lit this stage made it look -
   * the phone keeps the same rule at MainActivity.kt:5415-5419.
   */
  process(rgba, width, height, faceBox, light, nowMs, auto) {
    this.userOff = !auto;
    const box = snapRoi(faceBox, width, height);
    this.usingRoi = box !== null;

    // Measured on every frame, before any refusal to run: EyeEngine.kt:702-725 updates the face and
    // global means first and only then decides, so "sang mat" in the HUD stays true even while the
    // stage is paused or switched off.
    if (light) {
      this.faceMean = light.lumaMean;
      this.faceStd = light.std;
      this.globalMean = light.globalMean;
    }

    this.paused = nowMs < this.pausedUntilMs;
    if (!auto || this.paused || !light) {
      this.active = false;
      this.denoising = false;
      this.boostOn = false;
      this.boostFactor = 1;
      return {
        changed: false, active: false, denoising: false, paused: this.paused,
        costMs: this.costMs, boost: this.boostFactor,
      };
    }

    this.decide(nowMs, this.faceMean, this.faceStd);
    this.denoising = this.active && this.faceMean < DENOISE_MEAN;
    if (!this.active) {
      this.boostOn = false;
      this.boostFactor = 1;
      return {
        changed: false, active: false, denoising: false, paused: false,
        costMs: this.costMs, boost: this.boostFactor,
      };
    }

    const rx0 = box ? box.x0 : 0;
    const ry0 = box ? box.y0 : 0;
    const rw = box ? box.x1 - box.x0 : width;
    const rh = box ? box.y1 - box.y0 : height;
    const tiles = box ? TILES_ROI : TILES_FULL;

    const t0 = performance.now();

    // The very-dark band, before a single kernel runs. CLAHE can only stretch contrast that the sensor
    // left counts for; below BOOST_BELOW_MEAN the tiles are nearly empty and equalising them invents
    // structure - which is why the probe measured plain CLAHE doing WORSE than doing nothing there.
    // The gain is a multiply on R, G and B together, so hue is untouched, and it is capped at
    // BOOST_MAX_FACTOR so a near-black frame is not lifted into eight times its own noise.
    //
    // Engaged below 35, held until 45, and approached at BOOST_RISE / BOOST_FALL per frame rather than
    // applied at once: see BOOST_OFF_MEAN for the 47.8-level step this prevents.
    this.boostOn = this.boostOn ? this.faceMean <= BOOST_OFF_MEAN : this.faceMean < BOOST_BELOW_MEAN;
    const boostTarget = this.boostOn
      ? Math.min(BOOST_TARGET_MEAN / Math.max(this.faceMean, 1), BOOST_MAX_FACTOR)
      : 1;
    const alpha = boostTarget > this.boostFactor ? BOOST_RISE : BOOST_FALL;
    this.boostFactor += (boostTarget - this.boostFactor) * alpha;
    if (Math.abs(this.boostFactor - boostTarget) < 0.02) this.boostFactor = boostTarget;
    if (!this.boostOn && this.boostFactor < 1.02) this.boostFactor = 1;

    if (this.boostFactor > 1) {
      for (let row = 0; row < rh; row++) {
        let i = ((ry0 + row) * width + rx0) * 4;
        for (let col = 0; col < rw; col++, i += 4) {
          rgba[i] = rgba[i] * this.boostFactor;
          rgba[i + 1] = rgba[i + 1] * this.boostFactor;
          rgba[i + 2] = rgba[i + 2] * this.boostFactor;
        }
      }
    }

    const n = rw * rh;
    if (this.luma.length < n) this.luma = new Uint8Array(n);
    if (this.lumaBefore.length < n) this.lumaBefore = new Uint8Array(n);
    const luma = this.luma;
    const before = this.lumaBefore;

    for (let row = 0; row < rh; row++) {
      let i = ((ry0 + row) * width + rx0) * 4;
      const base = row * rw;
      for (let col = 0; col < rw; col++, i += 4) {
        const v = Math.trunc(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] + 0.5);
        luma[base + col] = clamp(v, 0, 255);
        before[base + col] = luma[base + col];
      }
    }

    if (this.denoising) blur3Plane(luma, rw, rh, this.scratch);
    clahePlane(luma, rw, rh, tiles, tiles, CLIP_LIMIT, this.scratch);

    for (let row = 0; row < rh; row++) {
      let i = ((ry0 + row) * width + rx0) * 4;
      const base = row * rw;
      for (let col = 0; col < rw; col++, i += 4) {
        const d = luma[base + col] - before[base + col];
        rgba[i] = rgba[i] + d;
        rgba[i + 1] = rgba[i + 1] + d;
        rgba[i + 2] = rgba[i + 2] + d;
      }
    }
    const ms = performance.now() - t0;

    this.costMs = this.enhancedFrames === 0 ? ms : this.costMs * 0.9 + ms * 0.1;
    this.enhancedFrames++;

    if (this.enhancedFrames > BUDGET_WARMUP_FRAMES && this.costMs > BUDGET_MS) {
      this.pausedUntilMs = nowMs + PAUSE_MS;
      this.active = false;
      this.denoising = false;
      this.boostOn = false;
      this.boostFactor = 1;
      this.enhancedFrames = 0;
      this.costMs = 0;
    }
    return {
      changed: true, active: true, denoising: this.denoising, paused: false,
      costMs: this.costMs, boost: this.boostFactor,
    };
  }

  /**
   * The band's own line, for the page's footer strip. Separate from describe() on purpose: that
   * sentence is the phone's and the checker pins it word for word, while this one describes something
   * no phone does. Empty when nothing was lifted.
   */
  boostText() {
    if (this.boostFactor <= 1) return '';
    return ' · nâng sáng ' + (Math.round(this.boostFactor * 10) / 10).toFixed(1)
      + 'x trước CLAHE (riêng máy tính)';
  }

  /**
   * EyeEngine.kt:934-956 describe, letter for letter, because this is the sentence the phone's
   * "Xử lý ảnh" row prints and the two windows are supposed to agree.
   */
  describe(backlit, overexposed) {
    let state;
    if (this.userOff) state = 'tăng cường ảnh: tắt';
    else if (this.paused) state = 'CLAHE tạm tắt để giữ FPS';
    else if (this.active) state = `CLAHE bật${this.denoising ? ' + lọc nhiễu' : ''} (${round1(this.costMs)} ms)`;
    else state = 'ánh sáng đủ, không cần tăng cường';
    const parts = [`sáng mặt ${Math.round(this.faceMean)} (toàn khung ${Math.round(this.globalMean)}) | tương phản ${Math.round(this.faceStd)} | ${state}`];
    if (backlit) parts.push('ngược sáng');
    if (overexposed) parts.push('mặt cháy sáng');
    return parts.join(' | ');
  }
}

const round1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
