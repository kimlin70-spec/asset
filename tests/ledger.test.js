import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/ledger.js';

// ---------- 도우미 ----------

const KRW = 'KRW';

function setup() {
  let l = L.emptyLedger();
  let r = L.ensureAccount(l, '키움');
  l = r.ledger;
  const kiwoom = r.accountId;
  r = L.ensureAccount(l, '국민은행');
  l = r.ledger;
  const bank = r.accountId;
  const add = (fields) => {
    const res = L.addItem(l, fields);
    l = res.ledger;
    return res.itemId;
  };
  const ids = {
    kiwoom,
    bank,
    cash: add({ accountId: kiwoom, name: '예수금', assetClass: '현금', currency: KRW }),
    usd: add({ accountId: kiwoom, name: '달러 예수금', assetClass: '현금', currency: 'USD' }),
    samsung: add({ accountId: kiwoom, name: '삼성전자', assetClass: '국내주식', code: '005930' }),
    aapl: add({ accountId: kiwoom, name: '애플', assetClass: '해외주식', code: 'AAPL' }),
    deposit: add({ accountId: bank, name: '입출금', assetClass: '현금', currency: KRW }),
    loan: add({ accountId: bank, name: '주택담보대출', assetClass: '부채', currency: KRW }),
  };
  return { get l() { return l; }, set l(v) { l = v; }, ids };
}

const bal = (l, id, opts) => L.computeBalances(l, opts).get(id) || 0;

const PRICES = {
  quotes: {
    'KR:005930': { price: 70000, currency: 'KRW', ok: true },
    'INTL:AAPL': { price: 200, currency: 'USD', ok: true },
    'FX:USD': { price: 1400, currency: 'KRW', ok: true },
  },
};

// ---------- 날짜 ----------

test('KST 날짜 경계: UTC 15시가 KST 자정', () => {
  assert.equal(L.kstDate(new Date('2026-11-04T14:59:59Z')), '2026-11-04');
  assert.equal(L.kstDate(new Date('2026-11-04T15:00:00Z')), '2026-11-05');
  assert.equal(L.kstDate(new Date('2026-12-31T15:00:00Z')), '2027-01-01');
});

test('날짜 형식 검사와 날짜 차이', () => {
  assert.ok(L.isDateStr('2026-02-28'));
  assert.ok(!L.isDateStr('2026-02-30'));
  assert.ok(!L.isDateStr('2026-2-3'));
  assert.equal(L.daysBetween('2026-10-31', '2026-11-05'), 5);
});

// ---------- 숫자 ----------

test('숫자 읽기: 쉼표, 괄호 음수, 원 기호', () => {
  assert.equal(L.parseNumber('1,234,567'), 1234567);
  assert.equal(L.parseNumber('(1,234)'), -1234);
  assert.equal(L.parseNumber('−5,000'), -5000);
  assert.equal(L.parseNumber('₩1,000원'), 1000);
  assert.equal(L.parseNumber('0.01234567'), 0.01234567);
  assert.ok(Number.isNaN(L.parseNumber('abc')));
  assert.ok(Number.isNaN(L.parseNumber('')));
});

test('코인 소수 합이 정확히 0으로 떨어지고 -0이 남지 않는다', () => {
  let l = L.emptyLedger();
  let r = L.ensureAccount(l, '업비트');
  l = r.ledger;
  r = L.addItem(l, { accountId: r.accountId, name: '비트코인', assetClass: '코인', code: 'btc' });
  l = r.ledger;
  const btc = r.itemId;
  l = L.addEntry(l, { date: '2026-11-01', type: 'in', lines: [{ itemId: btc, delta: 0.1 }] });
  l = L.addEntry(l, { date: '2026-11-02', type: 'in', lines: [{ itemId: btc, delta: 0.2 }] });
  l = L.addEntry(l, { date: '2026-11-03', type: 'out', lines: [{ itemId: btc, delta: -0.3 }] });
  const b = bal(l, btc);
  assert.equal(b, 0);
  assert.ok(Object.is(b, 0));
});

// ---------- 시세 출처 ----------

test('시세 출처는 코드로 정한다', () => {
  const k = (assetClass, code) => L.quoteKey({ assetClass, code });
  assert.equal(k('국내주식', '005930'), 'KR:005930');
  assert.equal(k('해외주식', '360750'), 'KR:360750'); // 국내 상장 미국 ETF를 해외주식으로 묶어도 국내 시세
  assert.equal(k('채권', '0091C0'), 'KR:0091C0'); // 영문이 섞인 국내 코드
  assert.equal(k('국내주식', '5930'), 'KR:005930'); // 엑셀이 앞자리 0을 지운 경우
  assert.equal(k('해외주식', 'aapl'), 'INTL:AAPL');
  assert.equal(k('해외주식', '7203.T'), 'INTL:7203.T');
  assert.equal(k('해외주식', '0700.HK'), 'INTL:0700.HK');
  assert.equal(k('해외주식', 'BRK-B'), 'INTL:BRK-B');
  assert.equal(k('코인', 'btc'), 'COIN:BTC');
  assert.equal(k('현금', ''), null);
  assert.equal(k('부채', undefined), null);
});

// ---------- 잔액과 실사 ----------

test('잔액 = 마지막 실사값 + 그 뒤 거래', () => {
  const s = setup();
  s.l = L.addEntry(s.l, { date: '2026-11-01', type: 'count', accountId: s.ids.kiwoom, values: [{ itemId: s.ids.cash, value: 1000000 }] });
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-03', cashItemId: s.ids.cash, amount: 700105, stockItemId: s.ids.samsung, qty: 10 }));
  assert.equal(bal(s.l, s.ids.cash), 299895);
  assert.equal(bal(s.l, s.ids.samsung), 10);
});

test('실사 이전 거래를 고쳐도 실사 이후 잔액은 그대로, 보정액만 바뀐다', () => {
  const s = setup();
  const { kiwoom, cash, samsung } = s.ids;
  s.l = L.addEntry(s.l, { date: '2026-11-01', type: 'count', accountId: kiwoom, values: [{ itemId: cash, value: 1000000 }] });
  // 단가×수량으로 대충 넣은 매수 70만
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-03', cashItemId: cash, amount: 700000, stockItemId: samsung, qty: 10 }));
  const buyId = s.l.entries.at(-1).id;
  // 월말 실사: 실제 예수금 299,895
  s.l = L.addEntry(s.l, { date: '2026-11-30', type: 'count', accountId: kiwoom, values: [{ itemId: cash, value: 299895 }, { itemId: samsung, value: 10 }] });
  const countId = s.l.entries.at(-1).id;
  assert.equal(bal(s.l, cash), 299895);
  assert.deepEqual(L.countDiffs(s.l, countId).find((d) => d.itemId === cash).diff, -105);
  // 거래내역 보고 정산금액으로 고침
  s.l = L.updateEntry(s.l, buyId, L.buyTx({ date: '2026-11-03', cashItemId: cash, amount: 700105, stockItemId: samsung, qty: 10 }));
  assert.equal(bal(s.l, cash), 299895); // 그대로
  assert.equal(L.countDiffs(s.l, countId).find((d) => d.itemId === cash).diff, 0); // 차이가 설명됨
  // 실사 이후 거래는 정상 반영
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-12-01', itemId: cash, amount: 105 }));
  assert.equal(bal(s.l, cash), 300000);
});

test('같은 날짜는 입력 순서: 실사(확인) 뒤에 입력한 같은 날 거래는 실사 뒤에 반영', () => {
  const s = setup();
  const { kiwoom, cash } = s.ids;
  s.l = L.addEntry(s.l, { date: '2026-11-30', type: 'count', accountId: kiwoom, values: [{ itemId: cash, value: 500000 }] });
  const tx = L.outTx({ date: '2026-11-30', itemId: cash, amount: 1000 });
  assert.deepEqual(L.absorbedBy(s.l, tx), []); // 새 거래는 실사 뒤
  s.l = L.addEntry(s.l, tx);
  assert.equal(bal(s.l, cash), 499000);
  // 실사 날짜보다 앞선 날짜로 넣으면 실사가 기준(안내 대상)
  const late = L.outTx({ date: '2026-11-29', itemId: cash, amount: 1000 });
  assert.deepEqual(L.absorbedBy(s.l, late), [{ itemId: cash, countDate: '2026-11-30' }]);
  s.l = L.addEntry(s.l, late);
  assert.equal(bal(s.l, cash), 499000);
});

test('같은 날 다시 실사해도 그 사이 거래가 두 번 더해지지 않는다', () => {
  const s = setup();
  const { kiwoom, cash } = s.ids;
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-11-30', values: [{ itemId: cash, value: 500000 }] });
  s.l = L.addEntry(s.l, L.outTx({ date: '2026-11-30', itemId: cash, amount: 1000 }));
  assert.equal(bal(s.l, cash), 499000);
  // 다시 실사: 실제 값 499,000(방금 거래 포함)
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-11-30', values: [{ itemId: cash, value: 499000 }] });
  assert.equal(bal(s.l, cash), 499000);
});

test('같은 날 실사를 다시 하면 새 실사가 뒤에 쌓이고 나중 것이 기준', () => {
  const s = setup();
  const { kiwoom, cash, samsung } = s.ids;
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-11-30', values: [{ itemId: cash, value: 1 }, { itemId: samsung, value: 3 }] });
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-11-30', values: [{ itemId: cash, value: 2 }] });
  assert.equal(s.l.entries.filter((e) => e.type === 'count').length, 2);
  assert.equal(bal(s.l, cash), 2);
  assert.equal(bal(s.l, samsung), 3);
  assert.deepEqual(L.validateLedger(s.l), []);
  const second = s.l.entries.at(-1);
  assert.deepEqual(L.countDiffs(s.l, second.id), [{ itemId: cash, value: 2, before: 1, diff: 1, first: false }]);
});

test('붙여넣기 단가는 같은 날 다시 실사해도 남는다(시세 오기 전 0원이 되지 않게)', () => {
  const { rows } = L.parsePaste('증권\t국내주식\tKODEX 200\t069500\t100\t\t100,000\n증권\t현금\t예수금\t\t1000\t\t');
  let l = L.applyPaste(L.emptyLedger(), rows, '2026-11-05');
  const kodex = l.items.find((i) => i.name === 'KODEX 200');
  const cash = l.items.find((i) => i.name === '예수금');
  l = L.addCount(l, { accountId: kodex.accountId, date: '2026-11-05', values: [{ itemId: kodex.id, value: 100 }, { itemId: cash.id, value: 900 }] });
  const row = L.valuate(l, { quotes: {} }).find((r) => r.item.id === kodex.id);
  assert.equal(row.status, 'temp');
  assert.equal(row.value, 100 * 100000);
  const first = l.entries.find((e) => e.memo === '붙여넣기');
  assert.ok(L.countDiffs(l, first.id).every((d) => d.first));
});

test('실사 날짜보다 앞선 날짜로 뒤늦게 넣은 거래: 실사한 항목은 흡수, 실사에 없던 항목은 반영', () => {
  const s = setup();
  const { kiwoom, cash, samsung } = s.ids;
  s.l = L.addEntry(s.l, { date: '2026-11-30', type: 'count', accountId: kiwoom, values: [{ itemId: cash, value: 300000 }] });
  // 11/10에 했던 매수를 12월에 뒤늦게 입력
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-10', cashItemId: cash, amount: 700000, stockItemId: samsung, qty: 10 }));
  assert.equal(bal(s.l, cash), 300000); // 예수금은 실사값이 기준
  assert.equal(bal(s.l, samsung), 10); // 실사에 없던 종목은 거래대로
});

test('실사를 지우면 거래 합으로 돌아가고, 실사값을 고치면 기준이 바뀐다', () => {
  const s = setup();
  const { kiwoom, cash } = s.ids;
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: cash, amount: 100000 }));
  s.l = L.addEntry(s.l, { date: '2026-11-30', type: 'count', accountId: kiwoom, values: [{ itemId: cash, value: 90000 }] });
  const countId = s.l.entries.at(-1).id;
  assert.equal(bal(s.l, cash), 90000);
  s.l = L.updateEntry(s.l, countId, { date: '2026-11-30', type: 'count', accountId: kiwoom, values: [{ itemId: cash, value: 95000 }] });
  assert.equal(bal(s.l, cash), 95000);
  s.l = L.removeEntry(s.l, countId);
  assert.equal(bal(s.l, cash), 100000);
});

test('asOf: 그 날짜까지만 반영', () => {
  const s = setup();
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: s.ids.cash, amount: 100 }));
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-05', itemId: s.ids.cash, amount: 50 }));
  assert.equal(bal(s.l, s.ids.cash, { asOf: '2026-11-04' }), 100);
  assert.equal(bal(s.l, s.ids.cash, { asOf: '2026-11-05' }), 150);
});

// ---------- 옮김 ----------

test('환전: 보낸 양과 받은 양이 달라도 된다', () => {
  const s = setup();
  const { cash, usd } = s.ids;
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: cash, amount: 2000000 }));
  s.l = L.addEntry(s.l, L.moveTx({ date: '2026-11-02', fromItemId: cash, fromAmount: 1400000, toItemId: usd, toAmount: 1000 }));
  assert.equal(bal(s.l, cash), 600000);
  assert.equal(bal(s.l, usd), 1000);
  const rows = L.valuate(s.l, PRICES);
  assert.equal(rows.find((r) => r.item.id === usd).value, 1400000);
});

test('외화 금액은 소수 2자리로 저장', () => {
  const s = setup();
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: s.ids.usd, amount: 10.005001 }));
  assert.equal(s.l.entries.at(-1).lines[0].delta, 10.01);
});

test('해외주식을 원화로 바로 매수(통합증거금)', () => {
  const s = setup();
  const { cash, aapl } = s.ids;
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: cash, amount: 3000000 }));
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-02', cashItemId: cash, amount: 2805000, stockItemId: aapl, qty: 10 }));
  assert.equal(bal(s.l, cash), 195000);
  const row = L.valuate(s.l, PRICES).find((r) => r.item.id === aapl);
  assert.equal(row.status, 'ok');
  assert.equal(row.currency, 'USD');
  assert.equal(row.value, 10 * 200 * 1400);
});

// ---------- 부채 ----------

test('부채: 양수로 넣으면 빚, 갚으면 줄고 빌리면 는다', () => {
  const s = setup();
  const { bank, deposit, loan } = s.ids;
  // 붙여넣기처럼 실사로 대출 1억(양수 입력)
  const loanItem = s.l.items.find((i) => i.id === loan);
  s.l = L.addEntry(s.l, {
    date: '2026-11-01',
    type: 'count',
    accountId: bank,
    values: [
      { itemId: deposit, value: 5000000 },
      { itemId: loan, value: L.toInternal(loanItem, 100000000) },
    ],
  });
  assert.equal(bal(s.l, loan), -100000000);
  assert.equal(L.toShown(loanItem, bal(s.l, loan)), 100000000);
  // 갚기: 통장 -> 대출 100만
  s.l = L.addEntry(s.l, L.moveTx({ date: '2026-11-25', fromItemId: deposit, fromAmount: 1000000, toItemId: loan, toAmount: 1000000 }));
  // 이자: 나간 돈
  s.l = L.addEntry(s.l, L.outTx({ date: '2026-11-25', itemId: deposit, amount: 300000 }));
  assert.equal(L.toShown(loanItem, bal(s.l, loan)), 99000000);
  assert.equal(bal(s.l, deposit), 3700000);
  let sum = L.summarize(L.valuate(s.l, PRICES));
  assert.equal(sum.debt, 99000000);
  assert.equal(sum.assets, 3700000);
  assert.equal(sum.net, 3700000 - 99000000);
  // 대출 받기: 대출 -> 통장 1천만
  s.l = L.addEntry(s.l, L.moveTx({ date: '2026-11-26', fromItemId: loan, fromAmount: 10000000, toItemId: deposit, toAmount: 10000000 }));
  sum = L.summarize(L.valuate(s.l, PRICES));
  assert.equal(sum.debt, 109000000);
  assert.equal(sum.net, 3700000 - 99000000); // 빌린 돈은 순자산을 바꾸지 않는다
  // 대출 실사: 은행 앱의 대출 잔액 1억 9백만(양수) — 음수로 넣어도 빚으로 본다
  assert.equal(L.toInternal(loanItem, -109000000), -109000000);
});

test('마이너스통장은 현금 항목: 마이너스 잔액은 부채로 합산', () => {
  const s = setup();
  s.l = L.addEntry(s.l, L.outTx({ date: '2026-11-01', itemId: s.ids.deposit, amount: 5000000 }));
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: s.ids.cash, amount: 8000000 }));
  const sum = L.summarize(L.valuate(s.l, PRICES));
  assert.equal(sum.assets, 8000000);
  assert.equal(sum.debt, 5000000);
  assert.equal(sum.net, 3000000);
  assert.equal(sum.byClass['현금'], 3000000);
});

// ---------- 바로잡기 ----------

test('액면분할 바로잡기: 바뀐 수량을 넣으면 차이를 기록', () => {
  const s = setup();
  const { cash, samsung } = s.ids;
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-01', cashItemId: cash, amount: 1000000, stockItemId: samsung, qty: 100 }));
  s.l = L.addEntry(s.l, L.adjustTx(s.l, { date: '2026-11-10', itemId: samsung, newShownValue: 5000 }));
  assert.equal(s.l.entries.at(-1).lines[0].delta, 4900);
  assert.equal(bal(s.l, samsung), 5000);
});

test('부채 바로잡기: 화면 값(빚)으로 맞춘다', () => {
  const s = setup();
  const loanItem = s.l.items.find((i) => i.id === s.ids.loan);
  s.l = L.addEntry(s.l, L.adjustTx(s.l, { date: '2026-11-10', itemId: s.ids.loan, newShownValue: 50000000 }));
  assert.equal(L.toShown(loanItem, bal(s.l, s.ids.loan)), 50000000);
});

// ---------- 평가 ----------

test('시세가 아직 없으면 마지막 매매 단가로 임시 계산', () => {
  const s = setup();
  let r = L.addItem(s.l, { accountId: s.ids.kiwoom, name: '새 종목', assetClass: '국내주식', code: '123456' });
  s.l = r.ledger;
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-02', cashItemId: s.ids.cash, amount: 1000500, stockItemId: r.itemId, qty: 100 }));
  const row = L.valuate(s.l, PRICES).find((x) => x.item.id === r.itemId);
  assert.equal(row.status, 'temp');
  assert.equal(row.value, 1000500);
  // 순자산이 매수 금액만큼 출렁이지 않는다
  assert.equal(L.summarize(L.valuate(s.l, PRICES)).net, 0);
});

test('시세 상태: 갱신 실패는 이전 가격, 시세·환율 없음은 0원', () => {
  const s = setup();
  const { cash, samsung, aapl, usd } = s.ids;
  s.l = L.addEntry(s.l, L.adjustTx(s.l, { date: '2026-11-01', itemId: samsung, newShownValue: 2 }));
  s.l = L.addEntry(s.l, L.adjustTx(s.l, { date: '2026-11-01', itemId: aapl, newShownValue: 1 }));
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: usd, amount: 10 }));
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: cash, amount: 5 }));
  const prices = { quotes: { 'KR:005930': { price: 70000, currency: 'KRW', ok: false } } };
  const rows = L.valuate(s.l, prices);
  const by = (id) => rows.find((x) => x.item.id === id);
  assert.equal(by(samsung).status, 'stale');
  assert.equal(by(samsung).value, 140000);
  assert.equal(by(aapl).status, 'none');
  assert.equal(by(aapl).value, 0);
  assert.equal(by(usd).status, 'nofx');
  assert.equal(by(usd).value, 0);
  assert.equal(by(cash).value, 5);
});

// ---------- history ----------

test('history: 같은 날은 덮어쓰고, 전일·지난달 말은 빠진 날이 있어도 찾는다', () => {
  let h = L.emptyHistory();
  h = L.putHistory(h, '2026-10-30', { net: 100 });
  h = L.putHistory(h, '2026-11-03', { net: 200 });
  h = L.putHistory(h, '2026-11-05', { net: 300 });
  h = L.putHistory(h, '2026-11-05', { net: 310 }); // 같은 날 다시 실행
  assert.equal(h.days['2026-11-05'].net, 310);
  const c = L.comparisons(h, '2026-11-05');
  assert.equal(c.prevDay.date, '2026-11-03'); // 11/4가 빠졌어도
  assert.equal(c.prevMonthEnd.date, '2026-10-30'); // 10/31이 빠졌어도
  const c2 = L.comparisons(h, '2026-11-01');
  assert.equal(c2.prevDay.date, '2026-10-30');
  assert.equal(c2.prevMonthEnd.date, '2026-10-30');
  assert.equal(L.comparisons(L.emptyHistory(), '2026-11-05').prevDay, null);
});

test('history 기록값: 그 날짜까지의 거래만, 순자산·자산·부채·자산군별', () => {
  const s = setup();
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: s.ids.cash, amount: 1000000 }));
  s.l = L.addEntry(s.l, L.adjustTx(s.l, { date: '2026-11-01', itemId: s.ids.loan, newShownValue: 300000 }));
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-06', itemId: s.ids.cash, amount: 999 }));
  const e = L.historyEntry(s.l, PRICES, '2026-11-05');
  assert.deepEqual(e, { net: 700000, assets: 1000000, debt: 300000, byClass: { 현금: 1000000, 부채: -300000 } });
});

test('그래프 자료: 최근 90일 일별, 월별은 각 달 마지막 기록', () => {
  let h = L.emptyHistory();
  for (const [d, net] of [['2026-07-01', 1], ['2026-08-10', 2], ['2026-08-31', 3], ['2026-10-01', 4], ['2026-11-05', 5]]) {
    h = L.putHistory(h, d, { net });
  }
  assert.deepEqual(L.historySeries(h, { mode: 'daily', today: '2026-11-05' }).map((p) => p.date), ['2026-08-10', '2026-08-31', '2026-10-01', '2026-11-05']);
  assert.deepEqual(L.historySeries(h, { mode: 'monthly' }).map((p) => p.net), [1, 3, 4, 5]);
});

test('마지막 실사: 잔액이 있는 계좌 중 가장 오래된 것', () => {
  const s = setup();
  const { kiwoom, bank, cash, deposit } = s.ids;
  s.l = L.addEntry(s.l, { date: '2026-10-01', type: 'count', accountId: kiwoom, values: [{ itemId: cash, value: 1 }] });
  s.l = L.addEntry(s.l, { date: '2026-10-20', type: 'count', accountId: bank, values: [{ itemId: deposit, value: 1 }] });
  s.l = L.addEntry(s.l, { date: '2026-10-31', type: 'count', accountId: kiwoom, values: [{ itemId: cash, value: 1 }] });
  const st = L.countStatus(s.l, '2026-11-05');
  assert.equal(st.oldest.accountId, bank);
  assert.equal(st.oldest.days, 16);
});

test('마지막 실사: 한 번도 실사 안 한 계좌는 첫 기록일부터 센다', () => {
  const s = setup();
  s.l = L.addEntry(s.l, { date: '2026-10-01', type: 'count', accountId: s.ids.kiwoom, values: [{ itemId: s.ids.cash, value: 1 }] });
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-10-02', itemId: s.ids.deposit, amount: 1 }));
  let st = L.countStatus(s.l, '2026-11-05');
  assert.equal(st.oldest.accountId, s.ids.kiwoom); // 35일 > 34일
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-09-15', itemId: s.ids.deposit, amount: 1 }));
  st = L.countStatus(s.l, '2026-11-05');
  assert.equal(st.oldest.accountId, s.ids.bank);
  assert.equal(st.oldest.date, null);
  assert.equal(st.oldest.days, 51);
  // 잔액이 모두 0인 계좌는 빠진다
  s.l = L.addEntry(s.l, L.outTx({ date: '2026-11-01', itemId: s.ids.deposit, amount: 2 }));
  assert.equal(L.countStatus(s.l, '2026-11-05').oldest.accountId, s.ids.kiwoom);
});

// ---------- 붙여넣기 ----------

test('엑셀 붙여넣기: 제목 줄 건너뛰기, 쉼표 숫자, 앞자리 0, 부채 양수', () => {
  const text = [
    '계좌\t자산군\t이름\t코드\t수량/금액\t통화',
    '키움\t국내주식\t삼성전자\t5930\t100\t',
    '키움\t현금\t예수금\t\t1,234,567\t',
    '키움\t현금\t달러 예수금\t\t1,234.56\tusd',
    '업비트\t코인\t비트코인\tBTC\t0.01234567\t',
    '국민은행\t부채\t주택담보대출\t\t100,000,000\t',
    '',
  ].join('\r\n');
  const { rows, errors } = L.parsePaste(text);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].code, '005930');
  assert.equal(rows[2].currency, 'USD');
  let l = L.applyPaste(L.emptyLedger(), rows, '2026-11-05');
  assert.deepEqual(L.validateLedger(l), []);
  assert.equal(l.accounts.length, 3);
  assert.equal(l.entries.filter((e) => e.type === 'count').length, 3); // 계좌별 실사
  const item = (name) => l.items.find((i) => i.name === name);
  const b = L.computeBalances(l);
  assert.equal(b.get(item('삼성전자').id), 100);
  assert.equal(b.get(item('달러 예수금').id), 1234.56);
  assert.equal(b.get(item('비트코인').id), 0.01234567);
  assert.equal(b.get(item('주택담보대출').id), -100000000);
  assert.equal(item('삼성전자').currency, undefined);
  assert.equal(item('예수금').currency, 'KRW');
  // 같은 표를 다시 붙여 넣으면 항목을 새로 만들지 않고 새 실사로 들어간다
  l = L.applyPaste(l, rows, '2026-12-01');
  assert.equal(l.items.length, 5);
  assert.equal(l.entries.length, 6);
});

test('엑셀 붙여넣기 오류 안내', () => {
  const text = ['키움\t주식\t삼성전자\t005930\t100', '키움\t현금\t\t\tabc', '은행\t부채\t대출\tX\t1', '키움\t현금\t예수금', '은행\t현금\t통장\t\t1\tDOLLARS'].join('\n');
  const { rows, errors } = L.parsePaste(text);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 5);
  assert.match(errors[0], /1번째 줄: 자산군/);
  assert.match(errors[1], /이름이 비었어요/);
  assert.match(errors[1], /숫자가 아니에요/);
  assert.match(errors[2], /부채는 코드를 비워/);
  assert.match(errors[3], /칸이 모자라요/);
  assert.match(errors[4], /영문 3글자/);
});

test('붙여넣기: 같은 계좌·이름이 두 번이면 오류', () => {
  const { errors } = L.parsePaste('키움\t현금\t예수금\t\t1\n키움\t현금\t예수금\t\t2');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /두 번/);
});

// ---------- 검사 ----------

test('잘못된 거래·항목은 저장 전에 막는다', () => {
  const s = setup();
  assert.throws(() => L.addEntry(s.l, { date: '2026-13-01', type: 'in', lines: [{ itemId: s.ids.cash, delta: 1 }] }), /날짜/);
  assert.throws(() => L.addEntry(s.l, { date: '2026-11-01', type: 'in', lines: [{ itemId: 'nope', delta: 1 }] }), /항목/);
  assert.throws(() => L.addEntry(s.l, { date: '2026-11-01', type: 'in', lines: [{ itemId: s.ids.cash, delta: 0 }] }), /금액/);
  assert.throws(
    () => L.addEntry(s.l, { date: '2026-11-01', type: 'count', accountId: s.ids.bank, values: [{ itemId: s.ids.cash, value: 1 }] }),
    /그 계좌에 없어요/,
  );
  assert.throws(() => L.addItem(s.l, { accountId: s.ids.kiwoom, name: '예수금', assetClass: '현금' }), /이미 있어요/);
  assert.throws(() => L.addItem(s.l, { accountId: s.ids.kiwoom, name: '뭔가', assetClass: '주식' }), /자산군/);
});

test('validateLedger: 없는 항목을 가리키는 기록을 찾아낸다', () => {
  const s = setup();
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: s.ids.cash, amount: 1 }));
  assert.deepEqual(L.validateLedger(s.l), []);
  const broken = { ...s.l, items: s.l.items.filter((i) => i.id !== s.ids.cash) };
  assert.ok(L.validateLedger(broken).some((p) => p.includes('없는 항목')));
});

test('고쳐도 입력 순서는 그대로', () => {
  const s = setup();
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: s.ids.cash, amount: 1 }));
  const first = s.l.entries[0];
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: s.ids.cash, amount: 2 }));
  s.l = L.updateEntry(s.l, first.id, L.inTx({ date: '2026-11-02', itemId: s.ids.cash, amount: 5 }));
  assert.equal(s.l.entries.find((e) => e.id === first.id).seq, first.seq);
  assert.equal(s.l.nextSeq, 3);
});

test('항목 고치기: 이름·코드·통화는 고칠 수 있다', () => {
  const s = setup();
  let l = L.updateItem(s.l, s.ids.samsung, { name: '삼성전자 보통주', code: '5930', assetClass: '해외주식' });
  const it = l.items.find((i) => i.id === s.ids.samsung);
  assert.equal(it.name, '삼성전자 보통주');
  assert.equal(it.code, '005930');
  assert.equal(it.assetClass, '해외주식');
  l = L.updateItem(l, s.ids.usd, { currency: '엔' });
  assert.equal(l.items.find((i) => i.id === s.ids.usd).currency, 'JPY');
});

test('항목 고치기: 수량↔금액, 코인 여부, 부채 여부, 계좌는 못 바꾼다', () => {
  const s = setup();
  assert.throws(() => L.updateItem(s.l, s.ids.cash, { code: '069500' }), /코드를 새로 넣거나 지울 수는 없어요/);
  assert.throws(() => L.updateItem(s.l, s.ids.samsung, { code: '' }), /코드를 새로 넣거나 지울 수는 없어요/);
  assert.throws(() => L.updateItem(s.l, s.ids.samsung, { assetClass: '코인' }), /코인/);
  assert.throws(() => L.updateItem(s.l, s.ids.loan, { assetClass: '현금' }), /부채/);
  assert.throws(() => L.updateItem(s.l, s.ids.deposit, { assetClass: '부채' }), /부채/);
  assert.throws(() => L.updateItem(s.l, s.ids.cash, { accountId: s.ids.bank }), /계좌/);
});

test('같은 계좌에 같은 코드는 하나: 다 팔아 숨은 종목도 다시 쓴다', () => {
  const s = setup();
  const { kiwoom, cash, samsung } = s.ids;
  assert.throws(() => L.addItem(s.l, { accountId: kiwoom, name: '삼성', assetClass: '국내주식', code: '005930' }), /이미 있어요/);
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-01', cashItemId: cash, amount: 1, stockItemId: samsung, qty: 1 }));
  s.l = L.addEntry(s.l, L.sellTx({ date: '2026-11-02', stockItemId: samsung, qty: 1, cashItemId: cash, amount: 1 }));
  assert.equal(bal(s.l, samsung), 0);
  const res = L.ensureItem(s.l, { accountId: kiwoom, name: '삼성전자(다시)', assetClass: '국내주식', code: 'A005930' });
  assert.equal(res.existed, true);
  assert.equal(res.itemId, samsung);
  const fresh = L.ensureItem(s.l, { accountId: kiwoom, name: '카카오', assetClass: '국내주식', code: '35720' });
  assert.equal(fresh.existed, false);
  assert.equal(fresh.ledger.items.find((i) => i.id === fresh.itemId).code, '035720');
});

test('HTS 형식 코드(A005930)도 국내 코드로', () => {
  assert.equal(L.normalizeCode('A005930'), '005930');
  assert.equal(L.normalizeCode(' a005930 '), '005930');
  assert.equal(L.normalizeCode('AAPL'), 'AAPL');
  assert.equal(L.normalizeCode('1INCH'), '1INCH');
});

test('Actions가 받을 시세와 환율: 원화로 산 미국 주식만 있어도 USD 환율', () => {
  const s = setup();
  const { cash, aapl, usd } = s.ids;
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-02', cashItemId: cash, amount: 2805000, stockItemId: aapl, qty: 10 }));
  assert.deepEqual(L.neededQuoteKeys(s.l), ['INTL:AAPL']);
  assert.deepEqual(L.neededCurrencies(s.l, { quotes: {} }), []); // 시세 전에는 원화 임시 단가
  assert.deepEqual(L.neededCurrencies(s.l, { quotes: { 'INTL:AAPL': { price: 200, currency: 'USD' } } }), ['USD']);
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-03', itemId: usd, amount: 5 }));
  assert.deepEqual(L.neededCurrencies(s.l, { quotes: {} }), ['USD']);
});

test('바로잡기를 고칠 때는 자기 자신을 빼고 다시 계산', () => {
  const s = setup();
  const { cash, samsung } = s.ids;
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-01', cashItemId: cash, amount: 1000000, stockItemId: samsung, qty: 100 }));
  s.l = L.addEntry(s.l, L.adjustTx(s.l, { date: '2026-11-10', itemId: samsung, newShownValue: 5000 }));
  const adj = s.l.entries.at(-1);
  // 분할 뒤 매수
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-11-15', cashItemId: cash, amount: 1, stockItemId: samsung, qty: 100 }));
  assert.equal(bal(s.l, samsung), 5100);
  // 분할 비율을 잘못 넣었다며 4,000주로 고침 → 분할일 기준으로 다시 계산
  s.l = L.updateEntry(s.l, adj.id, L.adjustTx(s.l, { date: '2026-11-10', itemId: samsung, newShownValue: 4000, excludeId: adj.id }));
  assert.equal(bal(s.l, samsung), 4100);
});

test('통화는 한글·기호로 적어도 알아듣는다', () => {
  assert.equal(L.normalizeCurrency(''), 'KRW');
  assert.equal(L.normalizeCurrency('원'), 'KRW');
  assert.equal(L.normalizeCurrency('won'), 'KRW');
  assert.equal(L.normalizeCurrency('달러'), 'USD');
  assert.equal(L.normalizeCurrency('$'), 'USD');
  assert.equal(L.normalizeCurrency('jpy'), 'JPY');
  assert.equal(L.normalizeCurrency('DOLLARS'), null);
  const { rows, errors } = L.parsePaste('키움\t현금\t달러 예수금\t\t12.5\t달러');
  assert.deepEqual(errors, []);
  assert.equal(rows[0].currency, 'USD');
});

test('붙여넣기 단가: 시세가 오기 전 임시 평가에 쓴다', () => {
  const text = ['계좌\t자산군\t이름\t코드\t수량\t통화\t단가', '증권\t해외주식\tTIGER 미국S&P500\t360750\t1,500\t\t25,000', '증권\t해외주식\t애플\tAAPL\t10\tUSD\t200.5', '증권\t현금\t예수금\t\t-\t\t'].join('\n');
  const { rows, errors } = L.parsePaste(text);
  assert.deepEqual(errors, []);
  assert.equal(rows[0].price, 25000);
  assert.equal(rows[2].amount, 0); // 회계 서식의 '-'
  const l = L.applyPaste(L.emptyLedger(), rows, '2026-11-05');
  assert.deepEqual(L.validateLedger(l), []);
  const byName = (n) => L.valuate(l, { quotes: { 'FX:USD': { price: 1400 } } }).find((r) => r.item.name === n);
  assert.equal(byName('TIGER 미국S&P500').status, 'temp');
  assert.equal(byName('TIGER 미국S&P500').value, 1500 * 25000);
  assert.equal(byName('애플').value, Math.round(10 * 200.5 * 1400));
  // 시세가 들어오면 시세를 쓴다
  const withQuote = L.valuate(l, { quotes: { 'KR:360750': { price: 27000, currency: 'KRW' } } }).find((r) => r.item.name === 'TIGER 미국S&P500');
  assert.equal(withQuote.status, 'ok');
  assert.equal(withQuote.value, 1500 * 27000);
  assert.deepEqual(L.neededCurrencies(l, { quotes: {} }), ['USD']);
});

test('붙여넣기: 단가가 숫자가 아니면 오류', () => {
  const { errors } = L.parsePaste('증권\t국내주식\t삼성전자\t005930\t10\t\tabc');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /단가/);
});

test('실사 기간 요약: 기록 안 한 현금 흐름(수입−지출)과 그 밖의 차이', () => {
  const s = setup();
  const { kiwoom, bank, cash, samsung, deposit } = s.ids;
  const prices = { quotes: { 'KR:005930': { price: 70000, currency: 'KRW' } } };
  // 9/5 첫 실사(붙여넣기 같은 시작 값)
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-09-05', values: [{ itemId: cash, value: 1000000 }, { itemId: samsung, value: 10 }] });
  s.l = L.addCount(s.l, { accountId: bank, date: '2026-09-05', values: [{ itemId: deposit, value: 5000000 }] });
  let first = L.periodSummary(s.l, prices, '2026-09-05');
  assert.equal(first.prevDate, null);
  assert.equal(first.added, 1000000 + 700000 + 5000000); // 시작 값은 흐름이 아니다
  assert.equal(first.cash, 0);
  // 그 사이 기록한 매수(정상 반영, 흐름 아님)
  s.l = L.addEntry(s.l, L.buyTx({ date: '2026-10-01', cashItemId: cash, amount: 700000, stockItemId: samsung, qty: 10 }));
  // 통장 잔액 고치기(빠뜨린 입금 100만): 기간 요약에 들어간다
  s.l = L.addEntry(s.l, L.adjustTx(s.l, { date: '2026-10-10', itemId: deposit, newShownValue: 6000000 }));
  // 11/4 실사: 통장 실제 4,200,000(생활비로 180만 더 씀), 삼성전자 실제 21주(기록 안 한 매수 1주)
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-11-04', values: [{ itemId: cash, value: 300000 }, { itemId: samsung, value: 21 }] });
  s.l = L.addCount(s.l, { accountId: bank, date: '2026-11-04', values: [{ itemId: deposit, value: 4200000 }] });
  const p = L.periodSummary(s.l, prices, '2026-11-04');
  assert.equal(p.prevDate, '2026-09-05');
  assert.equal(p.days, 60);
  assert.equal(p.cash, 1000000 - 1800000); // 고치기 +100만, 실사 차이 -180만
  assert.equal(p.other, 70000); // 삼성전자 +1주
  assert.equal(p.added, 0);
  assert.equal(p.cashPerMonth, Math.round((-800000 / 60) * 30.4));
  assert.equal(L.periodSummary(s.l, prices, '2026-10-01'), null);
  assert.deepEqual(L.countDates(s.l), ['2026-09-05', '2026-11-04']);
});

test('실사 기간 요약: 대출을 기록 없이 갚았으면 현금과 부채가 서로 상쇄된다', () => {
  const s = setup();
  const { bank, deposit, loan } = s.ids;
  const loanItem = s.l.items.find((i) => i.id === loan);
  s.l = L.addCount(s.l, { accountId: bank, date: '2026-09-01', values: [{ itemId: deposit, value: 5000000 }, { itemId: loan, value: L.toInternal(loanItem, 10000000) }] });
  s.l = L.addCount(s.l, { accountId: bank, date: '2026-11-01', values: [{ itemId: deposit, value: 4000000 }, { itemId: loan, value: L.toInternal(loanItem, 9000000) }] });
  const p = L.periodSummary(s.l, {}, '2026-11-01');
  assert.equal(p.cash, 0);
});

test('실사 기간 요약: 계좌마다 이전 실사가 달라도 기간을 계좌별로 잰다', () => {
  const s = setup();
  const { kiwoom, bank, cash, deposit } = s.ids;
  s.l = L.addCount(s.l, { accountId: bank, date: '2026-09-01', values: [{ itemId: deposit, value: 5000000 }] });
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-09-01', values: [{ itemId: cash, value: 1000000 }] });
  s.l = L.addEntry(s.l, L.adjustTx(s.l, { date: '2026-10-10', itemId: deposit, newShownValue: 6000000 })); // 빠뜨린 입금 +100만
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-10-20', values: [{ itemId: cash, value: 1000000 }] }); // 증권만 따로 실사
  s.l = L.addCount(s.l, { accountId: bank, date: '2026-11-01', values: [{ itemId: deposit, value: 3000000 }] });
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-11-01', values: [{ itemId: cash, value: 1000000 }] });
  const p = L.periodSummary(s.l, {}, '2026-11-01');
  assert.equal(p.prevDate, '2026-09-01');
  assert.equal(p.days, 61);
  assert.equal(p.cash, -2000000); // 고치기 +100만, 실사 차이 -300만
  assert.equal(p.cashPerMonth, Math.round((-2000000 / 61) * 30.4));
});

test('실사 기간 요약: 같은 날 다시 실사해도 새로 넣은 항목의 값은 흐름이 아니다', () => {
  const s = setup();
  const { kiwoom, bank, cash, deposit } = s.ids;
  s.l = L.addCount(s.l, { accountId: bank, date: '2026-09-01', values: [{ itemId: deposit, value: 5000000 }] });
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-11-01', values: [{ itemId: cash, value: 1000000 }] }); // 처음 넣은 계좌(오타)
  s.l = L.addCount(s.l, { accountId: kiwoom, date: '2026-11-01', values: [{ itemId: cash, value: 10000000 }] }); // 같은 날 바로잡음
  s.l = L.addCount(s.l, { accountId: bank, date: '2026-11-01', values: [{ itemId: deposit, value: 5000000 }] });
  const p = L.periodSummary(s.l, {}, '2026-11-01');
  assert.equal(p.added, 10000000);
  assert.equal(p.cash, 0);
});

test('붙여넣기: 이미 있는 항목과 부채 여부·통화가 다르면 막는다', () => {
  const s = setup();
  const text = ['키움\t부채\t예수금\t\t5,000,000\t', '키움\t현금\t달러 예수금\t\t1,400,000\t', '키움\t국내주식\t예수금2\t005930\t1\t'].join('\n');
  const { rows, errors } = L.parsePaste(text);
  assert.deepEqual(errors, []);
  const c = L.pasteConflicts(s.l, rows);
  assert.equal(c.length, 2);
  assert.match(c[0], /부채/);
  assert.match(c[1], /USD/);
  assert.throws(() => L.applyPaste(s.l, rows, '2026-11-05'), /부채/);
});

test('붙여넣기: "₩ -"는 0, 첫 줄이 숫자 없는 자료 줄이면 오류로 알린다', () => {
  let r = L.parsePaste('증권\t현금\t예수금\t\t₩ -\t');
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0].amount, 0);
  r = L.parsePaste('증권\t현금\t예수금\t\t#N/A\t\n증권\t현금\t달러\t\t1\tUSD');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /1번째 줄/);
});

test('같은 id로 다시 저장하면 두 번 들어가지 않는다(응답이 끊긴 뒤 다시 누른 저장)', () => {
  const s = setup();
  const tx = { ...L.inTx({ date: '2026-11-01', itemId: s.ids.cash, amount: 100 }), id: 't_fixed' };
  const once = L.addEntry(s.l, tx);
  const twice = L.addEntry(once, tx);
  assert.equal(twice, once);
  assert.equal(bal(twice, s.ids.cash), 100);
});

test('HTS 형식의 영문 섞인 국내 코드(A0091C0)', () => {
  assert.equal(L.normalizeCode('A0091C0'), '0091C0');
  assert.equal(L.quoteKey({ assetClass: '국내주식', code: 'A0091C0' }), 'KR:0091C0');
});

test('환율 갱신이 실패하면 외화 항목도 "갱신 실패"', () => {
  const s = setup();
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: s.ids.usd, amount: 10 }));
  const rows = L.valuate(s.l, { quotes: { 'FX:USD': { price: 1300, ok: false, at: '2026-10-01T00:00:00Z' } } });
  const r = rows.find((x) => x.item.id === s.ids.usd);
  assert.equal(r.status, 'stale');
  assert.equal(r.staleAt, '2026-10-01T00:00:00Z');
  assert.equal(r.value, 13000);
});

test('바로잡기: 바꿀 게 없으면 알린다', () => {
  const s = setup();
  s.l = L.addEntry(s.l, L.inTx({ date: '2026-11-01', itemId: s.ids.cash, amount: 100 }));
  assert.throws(() => L.adjustTx(s.l, { date: '2026-11-02', itemId: s.ids.cash, newShownValue: 100 }), /이미 그 값/);
});
