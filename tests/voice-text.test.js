import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSpokenAmount, normalizeVoiceText } from '../src/voice-text.js';
import { VoicePlayer } from '../src/voice-player.js';

test('spoken amounts omit decimal zeroes while preserving fractional value and debt signs', () => {
  for (const [input, expected] of [
    ['38.00', '38'], ['38.50', '38.5'], ['38.05', '38.05'], ['0.00', '0'], ['0.10', '0.1'],
    ['-28.00', '-28'], ['-28.50', '-28.5'], ['-0.05', '-0.05'], ['19.99', '19.99'],
    ['90071992547409.90', '90071992547409.9'], [38.5, '38.5']
  ]) assert.equal(formatSpokenAmount(input), expected, String(input));
});

test('templates normalize all monetary variables and retain names, identifiers and missing variables', () => {
  const player = new VoicePlayer();
  const vars = { name: '张三.00', amount: '100.00', balance: '-28.50', gift: '0.05', totalCredit: '100.05', memberId: 'ID-2.00' };
  assert.equal(player.formatTemplate('{name}实付{amount}，赠送{gift}，入账{totalCredit}，余额{balance}，{memberId}，{unknown}', vars),
    '张三.00实付100，赠送0.05，入账100.05，余额-28.5，ID-2.00，{unknown}');
  assert.equal(vars.amount, '100.00'); assert.equal(vars.balance, '-28.50');
});

test('installed client currency text and preview text lose only insignificant decimal zeroes', () => {
  const input = '实付100.00 元，赠送0.50元，余额-28.05 元，服务价￥38.00，折扣价¥19.90，优惠0.05块';
  const expected = '实付100 元，赠送0.5元，余额-28.05 元，服务价￥38，折扣价¥19.9，优惠0.05块';
  assert.equal(normalizeVoiceText(input), expected);
  assert.equal(normalizeVoiceText(expected), expected);
  assert.equal(normalizeVoiceText('版本v2.00、单号TX-2.00元、尾号0000、比例0.50、金额1.00.2元'),
    '版本v2.00、单号TX-2.00元、尾号0000、比例0.50、金额1.00.2元');
});
