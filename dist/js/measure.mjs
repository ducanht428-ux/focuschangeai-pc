// Pure measurement helpers, ported from the phone build so the computer reads the same quantities
// the same way. Each function names the Kotlin it came from.
//
// Landmarks arrive here as the MediaPipe array the browser gives back: 478 entries of
// {x, y, z} with x and y normalized to the frame. The phone packs the same values into a flat
// FloatArray (FocusCore.kt class Landmarks), where x(i) = data[i*3] and y(i) = data[i*3+1].
// Distances are computed in PIXELS (normalized value times the frame size), exactly like the phone,
// because a ratio built from normalized coordinates silently changes when the aspect ratio changes.

import {
  EYE_OUTER_WIDTH_CM,
  LM_BROW_INNER_L,
  LM_BROW_INNER_R,
  LM_MOUTH_L,
  LM_MOUTH_LOW,
  LM_MOUTH_R,
  LM_MOUTH_UP,
} from './params.mjs';

export const LM_NOSE_TIP = 1;
export const LM_FOREHEAD = 10;
export const LM_CHIN = 152;
export const LM_FACE_RIGHT = 234;
export const LM_FACE_LEFT = 454;
export const LM_OUTER_RIGHT_EYE = 33;
export const LM_OUTER_LEFT_EYE = 263;
export const IRIS_LANDMARKS = 478;
export const LM_RIGHT_IRIS = 468;
export const LM_LEFT_IRIS = 473;
export const LM_R_EYE_OUTER = 33;
export const LM_R_EYE_INNER = 133;
export const LM_L_EYE_INNER = 362;
export const LM_L_EYE_OUTER = 263;
export const LM_R_LID_UP = 159;
export const LM_R_LID_LOW = 145;
export const LM_L_LID_UP = 386;
export const LM_L_LID_LOW = 374;

export const RAD_TO_DEG = 57.29578;

/** MainActivity.kt:179-180 - the 6-point eye used for the HUD EAR and the calibration gate. */
export const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
export const LEFT_EYE = [362, 385, 387, 263, 373, 380];

// MainActivity.kt:315-328 - lighting and face-size floors behind the quality score.
export const LUMA_VERY_LOW = 35;
export const LUMA_LOW = 60;
export const LUMA_HIGH = 220;
export const MIN_FACE_PX = 40;
export const VERY_SMALL_FACE_PX = 25;
export const QUALITY_OK = 50;

export function pixelDistance(pts, a, b, width, height) {
  const dx = (pts[a].x - pts[b].x) * width;
  const dy = (pts[a].y - pts[b].y) * height;
  return Math.sqrt(dx * dx + dy * dy);
}

/** MainActivity.kt:2959 calculateEAR. Returns 1 when the eye has no measurable width. */
export function calculateEar(pts, e, width, height) {
  const vertical1 = pixelDistance(pts, e[1], e[5], width, height);
  const vertical2 = pixelDistance(pts, e[2], e[4], width, height);
  const horizontal = pixelDistance(pts, e[0], e[3], width, height);
  if (horizontal < 0.001) return 1;
  return (vertical1 + vertical2) / (2 * horizontal);
}

/** MainActivity.kt:3035 axisRatio - where the iris sits between two landmarks, 0 at a, 1 at b. */
export function axisRatio(pts, p, a, b, width, height) {
  const abx = (pts[b].x - pts[a].x) * width;
  const aby = (pts[b].y - pts[a].y) * height;
  const apx = (pts[p].x - pts[a].x) * width;
  const apy = (pts[p].y - pts[a].y) * height;
  const len2 = abx * abx + aby * aby;
  if (len2 < 0.000001) return 0.5;
  return (apx * abx + apy * aby) / len2;
}

/**
 * MainActivity.kt:3058 computeHeadPose - Euler angles from the face-plane normal, using MediaPipe z
 * as well. yaw positive = turned toward the subject's left, pitch positive = bending down.
 * The phone keeps the previous value when the normal collapses; this returns null for that frame and
 * lets the caller hold the last pose, which is the same thing in practice.
 */
export function computeHeadPose(pts, width, height) {
  const wf = width;
  const hf = height;

  const rx = (pts[LM_FACE_LEFT].x - pts[LM_FACE_RIGHT].x) * wf;
  const ry = (pts[LM_FACE_LEFT].y - pts[LM_FACE_RIGHT].y) * hf;
  const rz = (pts[LM_FACE_LEFT].z - pts[LM_FACE_RIGHT].z) * wf;

  const ux = (pts[LM_FOREHEAD].x - pts[LM_CHIN].x) * wf;
  const uy = (pts[LM_FOREHEAD].y - pts[LM_CHIN].y) * hf;
  const uz = (pts[LM_FOREHEAD].z - pts[LM_CHIN].z) * wf;

  const nx = ry * uz - rz * uy;
  const ny = rz * ux - rx * uz;
  const nz = rx * uy - ry * ux;

  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 0.000001) return null;

  const fx = nx / len;
  const fy = ny / len;
  const fz = nz / len;

  return {
    yawAbs: Math.atan2(fx, -fz) * RAD_TO_DEG,
    pitchAbs: Math.atan2(fy, Math.sqrt(fx * fx + fz * fz)) * RAD_TO_DEG,
    rollAbs: Math.atan2(ry, Math.max(Math.abs(rx), 0.0001)) * RAD_TO_DEG,
  };
}

/**
 * EyeEngine.kt ImageEnhancer.measure, reading the canvas instead of the camera Y plane.
 * The phone samples every 8th pixel of the frame and every 4th pixel of the face box, counts a
 * pixel "bright" above 245, and feeds the face mean into the quality score. Same strides here, so
 * the two machines average the same number of samples.
 *
 * Luma from RGB uses the BT.601 weights the camera itself uses for its Y channel, so the two means
 * are comparable; they are not identical (the camera Y is what the sensor actually wrote).
 */
export function measureLight(image, width, height, x0, y0, x1, y1, step) {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let bright = 0;

  for (let row = y0; row < y1; row += step) {
    for (let col = x0; col < x1; col += step) {
      const i = (row * width + col) * 4;
      const v = 0.299 * image[i] + 0.587 * image[i + 1] + 0.114 * image[i + 2];
      sum += v;
      sumSq += v * v;
      if (v > 245) bright++;
      n++;
    }
  }

  if (n === 0) return { mean: 128, std: 50, bright: 0 };
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return { mean, std: Math.sqrt(Math.max(variance, 0)), bright: bright / n };
}

/**
 * MainActivity.kt:3094 computeSignalQuality. Returns the 0-100 score and the reliable flag that
 * gates the eye analysis, from the same terms the phone uses.
 *
 * Deliberate gap: the phone also subtracts 15 for backlight and 20 for a blown-out face using the
 * CLAHE pass it runs for its own sake. Here those come from measureLight above, which is a second
 * getImageData cost per frame - so they are included, but the numbers they produce are coarser
 * because the browser cannot read a real Y plane.
 */
export function computeSignalQuality(lumaMean, faceWidthPx, yawAbs, pitchAbs, irisOk, backlit, overexposed) {
  let q = 100;
  let note = 'Tốt';

  if (lumaMean < LUMA_VERY_LOW) {
    q -= 60;
    note = 'Ánh sáng quá yếu';
  } else if (lumaMean < LUMA_LOW) {
    q -= 35;
    note = 'Ánh sáng yếu';
  } else if (lumaMean > LUMA_HIGH) {
    q -= 20;
    note = 'Ảnh quá sáng hoặc ngược sáng';
  }

  if (faceWidthPx < VERY_SMALL_FACE_PX) {
    q -= 50;
    note = 'Khuôn mặt quá xa';
  } else if (faceWidthPx < MIN_FACE_PX) {
    q -= 30;
    if (note === 'Tốt') note = 'Khuôn mặt hơi xa';
  }

  if (backlit) {
    q -= 15;
    if (note === 'Tốt') note = 'Ngược sáng, mặt bị tối';
  }
  if (overexposed) {
    q -= 20;
    if (note === 'Tốt') note = 'Mặt bị cháy sáng';
  }

  const reliable = q >= QUALITY_OK;

  if (yawAbs > 35 || pitchAbs > 30) {
    q -= 20;
    if (note === 'Tốt') note = 'Mặt quay nghiêng nhiều';
  }
  if (!irisOk) {
    q -= 10;
  }

  return { quality: Math.round(Math.min(Math.max(q, 0), 100)), reliable, note };
}

/**
 * MainActivity.kt:3949 gaze from the iris. Returns the raw horizontal/vertical ratios; without an
 * iris the phone falls back to 0.5 (centred), and that fallback is kept because the calibration
 * baseline is then centred too and the deviation stays consistent.
 */
export function rawGaze(pts, width, height) {
  if (pts.length < IRIS_LANDMARKS) return { h: 0.5, v: 0.5, irisOk: false };
  const hRight = axisRatio(pts, LM_RIGHT_IRIS, LM_R_EYE_OUTER, LM_R_EYE_INNER, width, height);
  const hLeft = axisRatio(pts, LM_LEFT_IRIS, LM_L_EYE_INNER, LM_L_EYE_OUTER, width, height);
  const vRight = axisRatio(pts, LM_RIGHT_IRIS, LM_R_LID_UP, LM_R_LID_LOW, width, height);
  const vLeft = axisRatio(pts, LM_LEFT_IRIS, LM_L_LID_UP, LM_L_LID_LOW, width, height);
  return { h: (hRight + hLeft) / 2, v: (vRight + vLeft) / 2, irisOk: true };
}

/**
 * The rectangle the phone reads the face luminance through. EyeEngine.kt gets a real detection box
 * from the face detector; the browser build only has landmarks, so the box is drawn around forehead,
 * chin and the two cheeks and widened a little. It is a close approximation, not the same pixels.
 */
export function faceRoi(pts, width, height) {
  const xs = [pts[LM_FACE_RIGHT].x, pts[LM_FACE_LEFT].x, pts[LM_FOREHEAD].x, pts[LM_CHIN].x];
  const ys = [pts[LM_FACE_RIGHT].y, pts[LM_FACE_LEFT].y, pts[LM_FOREHEAD].y, pts[LM_CHIN].y];
  let x0 = Math.min(...xs) * width;
  let x1 = Math.max(...xs) * width;
  let y0 = Math.min(...ys) * height;
  let y1 = Math.max(...ys) * height;
  const padX = (x1 - x0) * 0.1;
  const padY = (y1 - y0) * 0.1;
  x0 = Math.max(0, Math.floor(x0 - padX));
  x1 = Math.min(width, Math.ceil(x1 + padX));
  y0 = Math.max(0, Math.floor(y0 - padY));
  y1 = Math.min(height, Math.ceil(y1 + padY));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return { x0, y0, x1, y1 };
}

/**
 * EyeEngine.kt:1049-1063 (ImageEnhancer.decide inputs). Returns the three lighting facts the quality
 * score needs, with the phone's own thresholds: a face brighter than 18 per cent blown pixels is
 * overexposed, and a face more than 45 luma below the background while sitting under 95 is backlit.
 *
 * It also returns the contrast (`std`) and the whole-frame mean of the same region the lumaMean came
 * from, because the enhancer's controller decides on those two as well - on the phone they are the
 * mStd and globalMean measured inside ImageEnhancer.process, from the same pixels.
 *
 * Null ROI (face too close to the edge to box) falls back to whole-frame numbers, which is what
 * EyeEngine does when it has no box - including the looser 30 per cent overexposure floor.
 */
export function readLight(image, width, height, pts) {
  const global = measureLight(image, width, height, 0, 0, width, height, 8);
  const box = pts ? faceRoi(pts, width, height) : null;
  const roi = box ? measureLight(image, width, height, box.x0, box.y0, box.x1, box.y1, 4) : null;

  if (!roi) {
    return {
      lumaMean: global.mean, std: global.std, globalMean: global.mean,
      backlit: false, overexposed: global.bright > 0.30,
    };
  }
  return {
    lumaMean: roi.mean,
    std: roi.std,
    globalMean: global.mean,
    backlit: global.mean - roi.mean > 45 && roi.mean < 95,
    overexposed: roi.bright > 0.18,
  };
}

/**
 * MainActivity.kt:4182 - the quantity the phone learns a habit band for is the GAP BETWEEN the two
 * inner brow corners divided by the eye-corner span: frowning pulls those corners together and the
 * ratio drops. It is not a brow-to-lid vertical distance; that measurement also falls when someone
 * frowns, which is how a "0.88 of baseline" trigger ends up meaning a different number on each device.
 */
export function browFurrowRatio(pts, width, height) {
  if (pts.length < IRIS_LANDMARKS) return null;
  const span = pixelDistance(pts, LM_OUTER_RIGHT_EYE, LM_OUTER_LEFT_EYE, width, height);
  if (!(span > 0)) return null;
  return pixelDistance(pts, LM_BROW_INNER_R, LM_BROW_INNER_L, width, height) / span;
}

/**
 * MainActivity.kt:4186-4190 - lip-to-lip over mouth width, with the phone's own guard: a mouth box
 * under a pixel wide reports a SHUT mouth (0), not a huge one. jawOpen is not the MAR; on the phone it
 * is the second yawn clause and stays compared against its own threshold.
 */
export function mouthAspectRatio(pts, width, height) {
  if (pts.length < IRIS_LANDMARKS) return 0;
  const mouthW = pixelDistance(pts, LM_MOUTH_R, LM_MOUTH_L, width, height);
  if (mouthW < 1) return 0;
  return pixelDistance(pts, LM_MOUTH_UP, LM_MOUTH_LOW, width, height) / mouthW;
}

/**
 * constants.py focal_px. The focal length is a property of the LENS and the frame width, so it has to
 * be built from the frame the camera actually delivered. Deriving it from a crop instead (which this
 * build never did, but the class camera used to) makes every desk read several times too close and
 * wobbles with whatever box size the detector happened to draw.
 */
export function focalPx(frameWidth, horizontalFovDeg = 60) {
  return frameWidth / (2 * Math.tan((horizontalFovDeg * Math.PI) / 360));
}

/**
 * landmarks.py estimate_distance_cm: the outer eye-corner span is a fixed 8.9 cm on a human head, so
 * its pixel width against the focal length gives the distance, foreshortened by the head turn.
 * Returns null when the span is not measurable - "unknown" is a different claim from "far".
 */
export function estimateDistanceCm(pts, width, height, focal, yawAbsDeg) {
  if (pts.length < IRIS_LANDMARKS) return null;
  const cornerPx = pixelDistance(pts, LM_OUTER_RIGHT_EYE, LM_OUTER_LEFT_EYE, width, height);
  if (!(cornerPx > 1)) return null;
  const cosY = Math.cos(Math.min(Math.abs(yawAbsDeg), 60) * Math.PI / 180);
  return EYE_OUTER_WIDTH_CM * focal / (cornerPx / cosY);
}
