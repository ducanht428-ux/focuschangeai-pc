// Node-only suite for the per-kid simultaneous metrics line (hud.kidLine).
//
// The panel shows one line per RECOGNISED child so several kids in one frame each keep their own
// numbers on screen at once. These checks pin the honesty rules that matter there:
//   1. A calibrated child prints a real rounded SEI with its label, plus EAR and head angles.
//   2. An uncalibrated child prints a calibration count, NEVER a fabricated score.
//   3. A child with no result at all prints "chưa có số liệu", not a zero.
//   4. Missing geometry falls to '--' rather than NaN or 0.
// Nothing here quotes a real-face accuracy number, because none has been measured.
import { kidLine, toHud } from 'file:///C:/Users/Admin/Documents/Qoder/2026-10-21/4a36d25f/pc-app/dist/js/hud.mjs';

let fails = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok  ' + msg); } else { fails++; console.log('  FAIL ' + msg); }
}

const calibrated = toHud({
  calibrated: true, sei: 72, ear1: 0.21, ear2: 0.2, yawDeg: 3, pitchDeg: -2,
  alertCode: 0, personalSeiMean: 70, qualityNote: null,
});
const line = kidLine('An', calibrated);
ok(line.startsWith('An · '), 'line leads with the child name');
ok(line.includes('SEI 72 (Khá)'), 'calibrated SEI printed rounded with its label');
ok(line.includes('EAR 0.210/0.200'), 'both EAR values printed to 3 decimals');
ok(line.includes('Yaw +3°') && line.includes('Pitch -2°'), 'signed head angles printed');
ok(line.includes('không cảnh báo'), 'no alert reads "không cảnh báo"');

const calibrating = toHud({
  calibrated: false, calibration: { frames: 10, target: 60 },
  ear1: 0.2, ear2: 0.2, yawDeg: 0, pitchDeg: 0,
});
const cline = kidLine('Bình', calibrating);
ok(cline.includes('đang hiệu chuẩn 10/60'), 'uncalibrated SEI is a calibration count');
ok(!/SEI \d+ \(/.test(cline), 'uncalibrated child gets no fabricated score');
ok(cline.includes('EAR 0.200/0.200'), 'geometry still printed while calibrating');

ok(kidLine('Chi', null).includes('chưa có số liệu'), 'no result reads "chưa có số liệu", not a zero');

const sparse = toHud({ calibrated: true, sei: 55 });
const sline = kidLine('Dũng', sparse);
ok(sline.includes('EAR --/--'), 'missing EAR falls to dashes');
ok(sline.includes('Yaw --°') && sline.includes('Pitch --°'), 'missing angles fall to dashes');
ok(!sline.includes('NaN'), 'no NaN leaks into the line');

console.log(fails === 0 ? 'test-kidmetrics: ALL PASS' : 'test-kidmetrics: ' + fails + ' FAIL');
process.exit(fails === 0 ? 0 : 1);