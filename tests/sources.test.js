import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/ledger.js';
import { parseYahooChart, parseNaverBasic, parseUpbitTickers, erApiRate, updatePrices } from '../actions/sources.js';
import { utf8ToBase64, base64ToUtf8, parseRepo } from '../js/github.js';
import { fillWorkflowTemplate, appRepoFromLocation } from '../js/store.js';
import { readFileSync } from 'node:fs';

// ---------- 응답 해석 ----------

const yahooBody = (meta) => ({ chart: { result: [{ meta }], error: null } });

test('야후 chart: 가격·통화·이름, 펜스(GBp)는 파운드로', () => {
  assert.deepEqual(parseYahooChart(yahooBody({ regularMarketPrice: 25000, currency: 'KRW', longName: 'TEST ETF' })), {
    price: 25000,
    currency: 'KRW',
    name: 'TEST ETF',
  });
  const gbp = parseYahooChart(yahooBody({ regularMarketPrice: 512.4, currency: 'GBp', shortName: 'X' }));
  assert.equal(gbp.currency, 'GBP');
  assert.ok(Math.abs(gbp.price - 5.124) < 1e-9);
  assert.throws(() => parseYahooChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } }), /No data/);
  assert.throws(() => parseYahooChart(yahooBody({ regularMarketPrice: 0, currency: 'USD' })), /가격/);
});

test('네이버: 쉼표 든 가격 문자열', () => {
  assert.deepEqual(parseNaverBasic({ closePrice: '71,500', stockName: '삼성전자' }), { price: 71500, currency: 'KRW', name: '삼성전자' });
  assert.throws(() => parseNaverBasic({ closePrice: '-' }), /가격/);
});

test('업비트: 배열 응답, 오류 응답', () => {
  assert.deepEqual(parseUpbitTickers([{ market: 'KRW-BTC', trade_price: 140000000 }]), { BTC: { price: 140000000, currency: 'KRW', name: null } });
  assert.throws(() => parseUpbitTickers({ error: { name: 'Code not found', message: 'Code not found' } }), /Code not found/);
});

test('er-api: 달러 기준 응답에서 원화 환율 계산', () => {
  const body = { result: 'success', rates: { USD: 1, KRW: 1400, JPY: 150 } };
  assert.equal(erApiRate(body, 'USD'), 1400);
  assert.ok(Math.abs(erApiRate(body, 'JPY') - 1400 / 150) < 1e-9);
  assert.throws(() => erApiRate(body, 'XXX'), /XXX/);
});

// ---------- 시세 갱신 흐름(가짜 인터넷) ----------

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [pattern, reply] of routes) {
      if (url.includes(pattern)) {
        const r = typeof reply === 'function' ? reply(url) : reply;
        if (r.status && r.status !== 200) return { ok: false, status: r.status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => r.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

function sampleLedger() {
  let l = L.emptyLedger();
  const text = [
    '증권\t국내주식\t삼성전자\t005930\t10\t\t',
    '증권\t해외주식\t애플\tAAPL\t2\t\t',
    '증권\t현금\t달러 예수금\t\t100\tUSD\t',
    '업비트\t코인\t비트코인\tBTC\t0.5\t\t',
    '업비트\t코인\t없는코인\tNOPE\t1\t\t',
  ].join('\n');
  const { rows, errors } = L.parsePaste(text);
  assert.deepEqual(errors, []);
  return L.applyPaste(l, rows, '2026-11-05');
}

test('시세 갱신: 출처 순서, 환율은 시세 통화까지, 실패는 이전 가격 유지', async () => {
  const ledger = sampleLedger();
  const fetchImpl = fakeFetch([
    ['m.stock.naver.com/api/stock/005930', { body: { closePrice: '71,500', stockName: '삼성전자' } }],
    ['chart/AAPL', { body: yahooBody({ regularMarketPrice: 200, currency: 'USD', longName: 'Apple Inc.' }) }],
    ['chart/USDKRW=X', { status: 429 }],
    ['api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-NOPE', { status: 404 }],
    ['api.upbit.com/v1/ticker?markets=KRW-BTC', { body: [{ market: 'KRW-BTC', trade_price: 140000000 }] }],
    ['open.er-api.com', { body: { result: 'success', rates: { USD: 1, KRW: 1400 } } }],
  ]);
  const old = { version: 1, updatedAt: '2026-11-04T21:48:00Z', quotes: { 'COIN:NOPE': { price: 5, currency: 'KRW', ok: true, at: '2026-11-01T00:00:00Z' } } };
  const now = new Date('2026-11-05T21:48:00Z');
  const res = await updatePrices({ ledger, prices: old, mode: 'all', now, fetchImpl, delayMs: 0 });
  const q = res.prices.quotes;
  assert.equal(q['KR:005930'].price, 71500);
  assert.equal(q['KR:005930'].source, 'naver');
  assert.equal(q['INTL:AAPL'].currency, 'USD');
  assert.equal(q['COIN:BTC'].source, 'upbit');
  assert.equal(q['FX:USD'].price, 1400); // 야후가 막혀서 er-api
  assert.equal(q['FX:USD'].source, 'er-api');
  // 없는 코인: 실패 표시, 이전 가격 유지
  assert.equal(q['COIN:NOPE'].ok, false);
  assert.equal(q['COIN:NOPE'].price, 5);
  assert.equal(q['COIN:NOPE'].at, '2026-11-01T00:00:00Z');
  assert.match(q['COIN:NOPE'].error, /upbit/);
  assert.equal(res.prices.updatedAt, now.toISOString());
  assert.deepEqual(res.failed, ['COIN:NOPE']);
  // 계산 결과
  const sum = L.summarize(L.valuate(ledger, res.prices));
  assert.equal(sum.net, 715000 + 2 * 200 * 1400 + 100 * 1400 + 0.5 * 140000000 + 5);
});

test('시세 갱신: 국내는 네이버가 막히면 야후 .KS → .KQ', async () => {
  let l = L.emptyLedger();
  const { rows } = L.parsePaste('증권\t국내주식\t코스닥종목\t123456\t1\t\t');
  l = L.applyPaste(l, rows, '2026-11-05');
  const fetchImpl = fakeFetch([
    ['m.stock.naver.com', { status: 500 }],
    ['chart/123456.KS', { status: 404 }],
    ['chart/123456.KQ', { body: yahooBody({ regularMarketPrice: 9900, currency: 'KRW' }) }],
  ]);
  const res = await updatePrices({ ledger: l, prices: null, now: new Date('2026-11-05T00:00:00Z'), fetchImpl, delayMs: 0 });
  assert.equal(res.prices.quotes['KR:123456'].price, 9900);
  assert.equal(res.prices.quotes['KR:123456'].source, 'yahoo');
});

test('장부가 바뀔 때(missing 모드)는 시세가 없는 것만 받는다', async () => {
  const ledger = sampleLedger();
  const fetchImpl = fakeFetch([
    ['chart/AAPL', { body: yahooBody({ regularMarketPrice: 210, currency: 'USD' }) }],
    ['chart/USDKRW', { body: yahooBody({ regularMarketPrice: 1390, currency: 'KRW' }) }],
  ]);
  const prev = {
    version: 1,
    updatedAt: '2026-11-04T21:48:00Z',
    quotes: {
      'KR:005930': { price: 70000, currency: 'KRW', ok: true, tried: '2026-11-04T21:48:00Z' },
      'COIN:BTC': { price: 1, currency: 'KRW', ok: true, tried: '2026-11-04T21:48:00Z' },
      'COIN:NOPE': { price: 1, currency: 'KRW', ok: true, tried: '2026-11-04T21:48:00Z' },
    },
  };
  const res = await updatePrices({ ledger, prices: prev, mode: 'missing', now: new Date('2026-11-05T03:00:00Z'), fetchImpl, delayMs: 0 });
  assert.ok(fetchImpl.calls.every((u) => !u.includes('naver') && !u.includes('upbit')));
  assert.equal(res.prices.quotes['INTL:AAPL'].price, 210);
  assert.equal(res.prices.quotes['FX:USD'].price, 1390);
  assert.equal(res.prices.updatedAt, '2026-11-04T21:48:00Z'); // 전체 갱신 시각은 그대로
});

// ---------- GitHub 도우미 ----------

test('base64는 UTF-8 기준(한글 이름이 깨지지 않게)', () => {
  const text = JSON.stringify({ name: '가나증권 종합 (홍길동) · 미국S&P500 ETF ₩' });
  assert.equal(base64ToUtf8(utf8ToBase64(text)), text);
  assert.equal(base64ToUtf8(Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n')), text);
});

test('저장소 이름 읽기', () => {
  assert.deepEqual(parseRepo('kimlin70-spec/asset-data'), { owner: 'kimlin70-spec', repo: 'asset-data' });
  assert.deepEqual(parseRepo(' https://github.com/kimlin70-spec/asset-data.git '), { owner: 'kimlin70-spec', repo: 'asset-data' });
  assert.equal(parseRepo('asset-data'), null);
  assert.equal(parseRepo('a/b/c'), null);
});

test('자동 시세 설정 파일: 앱 저장소 이름을 채운다', () => {
  const tpl = readFileSync(new URL('../setup/asset-prices.yml', import.meta.url), 'utf8');
  assert.match(tpl.split('\n')[0], /^# asset-prices v\d+/);
  const filled = fillWorkflowTemplate(tpl, 'kimlin70-spec/asset');
  assert.ok(!filled.includes('__APP_REPO__'));
  assert.match(filled, /repository: kimlin70-spec\/asset/);
  assert.match(filled, /cron: '47 21 \* \* \*'/);
  assert.match(filled, /contents: write/);
  assert.match(filled, /timeout-minutes: 10/);
  assert.equal(appRepoFromLocation({ hostname: 'kimlin70-spec.github.io', pathname: '/asset/' }), 'kimlin70-spec/asset');
  assert.equal(appRepoFromLocation({ hostname: 'localhost', pathname: '/' }), 'kimlin70-spec/asset');
});

test('missing 모드: 마지막 전체 갱신 전에 받은 옛 시세(다 팔았다 다시 산 종목)는 다시 받는다', async () => {
  let l = L.emptyLedger();
  const { rows } = L.parsePaste('증권\t해외주식\t애플\tAAPL\t10\t\t');
  l = L.applyPaste(l, rows, '2026-11-05');
  const fetchImpl = fakeFetch([
    ['chart/AAPL', { body: yahooBody({ regularMarketPrice: 260, currency: 'USD' }) }],
    ['chart/USDKRW', { body: yahooBody({ regularMarketPrice: 1400, currency: 'KRW' }) }],
  ]);
  const prev = { version: 1, updatedAt: '2026-11-04T21:48:00Z', quotes: { 'INTL:AAPL': { price: 150, currency: 'USD', ok: true, at: '2026-01-18T21:48:00Z', tried: '2026-01-18T21:48:00Z' } } };
  const res = await updatePrices({ ledger: l, prices: prev, mode: 'missing', now: new Date('2026-11-05T03:00:00Z'), fetchImpl, delayMs: 0 });
  assert.equal(res.prices.quotes['INTL:AAPL'].price, 260);
});

test('업비트가 통째로 안 되면 "없는 코드"가 아니라 실제 오류를 남긴다', async () => {
  const ledger = sampleLedger();
  const fetchImpl = fakeFetch([['api.upbit.com', { status: 503 }]]);
  const res = await updatePrices({ ledger, prices: null, now: new Date('2026-11-05T00:00:00Z'), fetchImpl, delayMs: 0 });
  assert.match(res.prices.quotes['COIN:BTC'].error, /upbit: HTTP 503/);
  assert.doesNotMatch(res.prices.quotes['COIN:BTC'].error, /없는 코드/);
});
