import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtWon, fmtWonChange, fmtWonFull, fmtMoney, fmtNum, changeClass } from '../js/format.js';

test('원화 억·만 단위', () => {
  assert.equal(fmtWon(523456789), '5억 2,346만원');
  assert.equal(fmtWon(100000000), '1억원');
  assert.equal(fmtWon(99999999), '1억원'); // 반올림해서 1억
  assert.equal(fmtWon(1234567890123), '12,345억 6,789만원');
  assert.equal(fmtWon(12345), '1만원');
  assert.equal(fmtWon(9999), '9,999원');
  assert.equal(fmtWon(0), '0원');
  assert.equal(fmtWon(-5000000), '−500만원');
  assert.equal(fmtWon(-0.4), '0원');
  assert.equal(fmtWon(NaN), '-');
});

test('증감 표시와 색', () => {
  assert.equal(fmtWonChange(12340000), '+1,234만원');
  assert.equal(fmtWonChange(-5670000), '−567만원');
  assert.equal(fmtWonChange(0), '0원');
  assert.equal(changeClass(1), 'up');
  assert.equal(changeClass(-1), 'down');
  assert.equal(changeClass(0.2), 'flat');
});

test('원 단위 전체, 외화, 수량', () => {
  assert.equal(fmtWonFull(1234567), '1,234,567원');
  assert.equal(fmtMoney(1234.5, 'USD'), '$1,234.50');
  assert.equal(fmtMoney(-3, 'USD'), '−$3.00');
  assert.equal(fmtMoney(1500, 'JPY'), '1,500 JPY');
  assert.equal(fmtMoney(1234567, 'KRW'), '1,234,567원');
  assert.equal(fmtNum(0.01234567, 8), '0.01234567');
  assert.equal(fmtNum(1234, 8), '1,234');
  assert.equal(fmtNum(-0.000000001, 8), '0');
  assert.equal(fmtNum(-1234.5, 2), '−1,234.5');
});
