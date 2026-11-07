// The alert chain and the sentences it prints, ported from edge-server/focusedge/person_pipeline.py
// (_pick_alert) and hud.py (ALERT_SENTENCES), both of which mirror MainActivity.kt:4704-4736.
//
// Order is the product. Two conditions can be true in the same frame and only the first sentence is
// ever shown, so a chain that shuffles them reports a different cause for the same minute of video.
// The phone also runs this chain TWICE - once for the sentence, once for the tally - and the two lists
// are not equal, which is why this returns {code, counted, held} instead of a string.

const UNCOUNTED_ALERTS = new Set(['UNRELIABLE', 'CONFUSED', 'NOISY']);
const HELD_ALERT_CODES = new Set(['DROWSY', 'SQUINT']);

/**
 * @param {object} a facts about this frame: reliable, drowsy, perclos, drift, lookAway, yawn, bpm,
 *   bpmReliable, squint, asym, incomplete, noisy, breakReminder, confused, lowVsPersonal.
 * @param {{perclos:number, blinkLow:number, blinkHigh:number}} thr this student's own thresholds.
 * @returns {{code:?string, counted:boolean, held:boolean}}
 */
export function pickAlert(a, thr, engine, sf, nowMs) {
  let code = null;
  if (!a.reliable) code = 'UNRELIABLE';
  else if (a.drowsy) code = 'DROWSY';
  else if (a.perclos !== null && a.perclos >= thr.perclos) code = 'PERCLOS_HIGH';
  else if (a.drift) code = 'VISUAL_DRIFT';
  else if (a.lookAway) code = 'LOOK_AWAY';
  else if (a.yawn) code = 'YAWN';
  else if (a.bpmReliable && a.bpm !== null && a.bpm < thr.blinkLow) code = 'LOW_BLINK';
  else if (a.squint) code = 'SQUINT';
  else if (a.asym) code = 'ASYMMETRY';
  else if (a.incomplete) code = 'INCOMPLETE_BLINK';
  else if (a.bpmReliable && a.bpm !== null && a.bpm > thr.blinkHigh) code = 'HIGH_BLINK';
  else if (a.breakReminder) code = 'BREAK';
  else if (a.confused) code = 'CONFUSED';
  else if (a.lowVsPersonal) code = 'LOW_VS_PERSONAL';
  else if (a.noisy) code = 'NOISY';

  const counted = code !== null && !UNCOUNTED_ALERTS.has(code);
  // Only the two alerts whose evidence is "the eye looks closed in this frame" can be held. PERCLOS is
  // deliberately not one of them: it is a ratio over a whole minute, so delaying it frame by frame
  // would bend the measurement rather than the reading of it.
  const held = !engine.allow(HELD_ALERT_CODES.has(code), sf, nowMs);
  return { code, counted, held };
}

// Word for word from MainActivity.kt:4705-4735, in the phone's own branch order. TOO_CLOSE is absent
// on purpose: sitting closer than 30 cm is its own permanent line above this column on the phone, not
// a member of the chain, and printing it in both places would let one fact outrank everything below.
export const ALERT_SENTENCES = {
  UNRELIABLE: '⚠ Tín hiệu kém (%s) - kết quả có thể không chính xác.',
  DROWSY: '⚠ Nhắm mắt quá lâu - bạn có thể đang buồn ngủ!',
  PERCLOS_HIGH: '⚠ Dấu hiệu mệt mỏi (PERCLOS cao) - hãy nghỉ ngơi.',
  VISUAL_DRIFT: '⚠ Visual Drift: ánh mắt rời màn hình quá 3 giây.',
  LOOK_AWAY: '⚠ Đầu bạn đang quay lệch khỏi màn hình.',
  YAWN: '⚠ Bạn đang ngáp - dấu hiệu mệt mỏi.',
  LOW_BLINK: '⚠ Chớp mắt quá ít - hãy chớp mắt thường xuyên hơn.',
  SQUINT: '⚠ Mắt khép hoặc nheo một phần kéo dài - có thể chói, mỏi hoặc khó chịu. Hãy nghỉ mắt và chỉnh độ sáng.',
  ASYMMETRY: 'ℹ Hai mắt mở không đều trong thời gian dài - hãy nghỉ mắt; nếu hay lặp lại, hãy báo người lớn hoặc giáo viên.',
  INCOMPLETE_BLINK: 'ℹ Chớp mắt không hoàn toàn - mắt dễ khô, hãy chớp mắt chậm và đầy đủ.',
  HIGH_BLINK: 'ℹ Chớp mắt rất nhiều - mắt có thể đang khô hoặc bị kích ứng, hãy nghỉ mắt.',
  BREAK: '⏰ Đã 20 phút: hãy nhìn xa 6 m trong 20 giây (quy tắc 20-20-20).',
  CONFUSED: 'ℹ Bạn có vẻ đang căng thẳng hoặc bối rối với nội dung.',
  LOW_VS_PERSONAL: 'ℹ Mức tập trung đang thấp hơn thường ngày của bạn (thường khoảng %s).',
  NOISY: 'ℹ Kính phản chiếu hoặc ánh sáng chói đang gây nhiễu - hãy nghiêng màn hình, giảm chói hoặc tăng ánh sáng đều.',
};

/**
 * The two branches that carry a value inside the sentence are substituted by name, not by a generic
 * format pass: feeding one placeholder the arguments of the other is how a quality note ends up
 * printed where the phone would have printed this student's usual SEI.
 */
export function alertSentence(code, personalSeiMean = null, qualityNote = null) {
  if (!code) return '';
  if (code === 'LOW_VS_PERSONAL') return ALERT_SENTENCES[code].replace('%s', String(personalSeiMean ?? '--'));
  if (code === 'UNRELIABLE') return ALERT_SENTENCES[code].replace('%s', qualityNote ?? '--');
  return ALERT_SENTENCES[code] ?? code;
}
