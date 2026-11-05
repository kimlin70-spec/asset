// 시세 받기(비공식 출처). 데이터 저장소의 GitHub Actions에서 Node로 돈다.
// 출처별로 나누고 실패하면 다음 출처. 모두 실패하면 이전 가격을 두고 실패만 적는다.
//   국내: 네이버 → 야후 .KS → 야후 .KQ   (GitHub 서버에서 야후가 막히는 일이 있어 네이버 먼저)
//   해외: 야후
//   코인: 업비트(묶음) → 야후 {코드}-KRW
//   환율: 야후 {통화}KRW=X → open.er-api.com (실행당 한 번)
import * as L from '../js/ledger.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJSON(url, { fetchImpl = (...a) => fetch(...a), timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const t = new Error('응답 없음(10초)');
      t.status = 0;
      throw t;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 야후가 보조 단위로 주는 통화(런던 펜스 등)
const MINOR_UNITS = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };

export function parseYahooChart(json) {
  const chart = json && json.chart;
  if (chart && chart.error) throw new Error(chart.error.description || chart.error.code || '야후 오류');
  const meta = chart && chart.result && chart.result[0] && chart.result[0].meta;
  if (!meta) throw new Error('응답에 가격 정보 없음');
  let price = Number(meta.regularMarketPrice);
  let currency = meta.currency || 'USD';
  if (!(price > 0)) throw new Error('가격 없음');
  if (MINOR_UNITS[currency]) {
    const [cur, div] = MINOR_UNITS[currency];
    price /= div;
    currency = cur;
  }
  return { price, currency, name: meta.longName || meta.shortName || null };
}

export async function yahoo(symbol, ctx) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol).replace(/%3D/g, '=')}?range=1d&interval=1d`;
  try {
    return parseYahooChart(await getJSON('https://query1.finance.yahoo.com' + path, ctx));
  } catch (e) {
    // 요청이 많다고 막히면(429) 다른 주소로 한 번만 다시
    if (e.status === 429) return parseYahooChart(await getJSON('https://query2.finance.yahoo.com' + path, ctx));
    throw e;
  }
}

// 네이버 closePrice는 쉼표가 든 문자열("71,500")
export function parseNaverBasic(json) {
  const raw = json && (json.closePrice ?? json.currentPrice);
  const price = Number(String(raw ?? '').replace(/,/g, ''));
  if (!(price > 0)) throw new Error('가격 없음');
  return { price, currency: 'KRW', name: (json && json.stockName) || null };
}

export async function naver(code, ctx) {
  return parseNaverBasic(await getJSON(`https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/basic`, ctx));
}

export function parseUpbitTickers(json) {
  if (!Array.isArray(json)) throw new Error((json && json.error && (json.error.message || json.error.name)) || '업비트 응답 이상');
  const out = {};
  for (const t of json) {
    const code = String(t.market || '').replace(/^KRW-/, '');
    const price = Number(t.trade_price);
    if (code && price > 0) out[code] = { price, currency: 'KRW', name: null };
  }
  return out;
}

export async function upbit(codes, ctx) {
  if (!codes.length) return {};
  const url = 'https://api.upbit.com/v1/ticker?markets=' + codes.map((c) => 'KRW-' + encodeURIComponent(c)).join(',');
  try {
    return parseUpbitTickers(await getJSON(url, ctx));
  } catch (e) {
    if (codes.length === 1) throw e;
    // 틀린 코드가 하나라도 섞이면 묶음 전체가 실패할 수 있어 하나씩 다시. 전부 실패하면 업비트 문제로 본다.
    const out = {};
    for (const c of codes) {
      try {
        Object.assign(out, await upbit([c], ctx));
      } catch {
        /* 이 코드만 실패 */
      }
    }
    if (!Object.keys(out).length) throw e;
    return out;
  }
}

// open.er-api.com/v6/latest/USD 응답에서 1 통화 = ? 원
export function erApiRate(json, currency) {
  if (!json || json.result !== 'success' || !json.rates) throw new Error('환율 응답 이상');
  const krw = Number(json.rates.KRW);
  const cur = Number(json.rates[currency]);
  if (!(krw > 0) || !(cur > 0)) throw new Error(`${currency} 환율 없음`);
  return krw / cur;
}

function splitKey(key) {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

// 시세 갱신. mode 'all'(매일·수동): 잔액 있는 전 종목, 'missing'(장부 변경 때): 시세가 아직 없는 것만.
export async function updatePrices({ ledger, prices, mode = 'all', now = new Date(), fetchImpl, delayMs = 700 }) {
  const ctx = { fetchImpl: fetchImpl || ((...a) => fetch(...a)) };
  const at = now.toISOString();
  const quotes = { ...((prices && prices.quotes) || {}) };
  // 'missing' 모드에서 "있다"는 것은 마지막 전체 갱신 뒤에 받은 시세만(다 팔았다 다시 산 종목의 옛 가격은 다시 받는다)
  const updatedAt = prices && prices.updatedAt;
  const has = (key) => {
    const q = quotes[key];
    return !!(q && q.price > 0 && (mode === 'all' || (updatedAt && q.tried && q.tried >= updatedAt)));
  };
  const ok = [];
  const failed = [];
  const put = (key, q, source) => {
    const old = quotes[key] || {};
    quotes[key] = { price: q.price, currency: q.currency, name: q.name || old.name || null, source, at, tried: at, ok: true };
    ok.push(key);
  };
  const fail = (key, errors) => {
    quotes[key] = { ...(quotes[key] || {}), ok: false, tried: at, error: errors.join(' / ').slice(0, 300) };
    failed.push(key);
  };
  let yahooCalls = 0;
  const paced = async (fn) => {
    if (yahooCalls++ > 0) await sleep(delayMs); // 야후는 하나씩, 사이를 두고
    return fn();
  };

  const want = L.neededQuoteKeys(ledger).filter((k) => mode === 'all' || !has(k));

  let upbitMap = {};
  let upbitErr = '';
  const coinCodes = want.filter((k) => k.startsWith('COIN:')).map((k) => splitKey(k)[1]);
  if (coinCodes.length) {
    try {
      upbitMap = await upbit(coinCodes, ctx);
    } catch (e) {
      upbitErr = e.message;
    }
  }

  for (const key of want) {
    const [kind, code] = splitKey(key);
    const errors = [];
    const attempt = async (source, fn) => {
      try {
        put(key, await fn(), source);
        return true;
      } catch (e) {
        errors.push(`${source}: ${e.message}`);
        return false;
      }
    };
    if (kind === 'COIN') {
      if (upbitMap[code]) {
        put(key, upbitMap[code], 'upbit');
        continue;
      }
      errors.push('upbit: ' + (upbitErr || '없는 코드'));
      if (await attempt('yahoo', () => paced(() => yahoo(`${code}-KRW`, ctx)))) continue;
    } else if (kind === 'KR') {
      if (await attempt('naver', () => naver(code, ctx))) continue;
      if (await attempt('yahoo', () => paced(() => yahoo(`${code}.KS`, ctx)))) continue;
      if (await attempt('yahoo', () => paced(() => yahoo(`${code}.KQ`, ctx)))) continue;
    } else if (await attempt('yahoo', () => paced(() => yahoo(code, ctx)))) {
      continue;
    }
    fail(key, errors);
  }

  // 환율: 금액 항목의 외화 + 방금 받은 시세의 통화
  let er = null;
  let erErr = '';
  for (const cur of L.neededCurrencies(ledger, { quotes })) {
    const key = L.fxKey(cur);
    if (mode !== 'all' && has(key)) continue;
    const errors = [];
    try {
      put(key, await paced(() => yahoo(`${cur}KRW=X`, ctx)), 'yahoo');
      continue;
    } catch (e) {
      errors.push('yahoo: ' + e.message);
    }
    try {
      if (!er && !erErr) {
        try {
          er = await getJSON('https://open.er-api.com/v6/latest/USD', ctx);
        } catch (e) {
          erErr = e.message;
        }
      }
      if (!er) throw new Error(erErr);
      put(key, { price: erApiRate(er, cur), currency: 'KRW', name: null }, 'er-api');
      continue;
    } catch (e) {
      errors.push('er-api: ' + e.message);
    }
    fail(key, errors);
  }

  return { prices: { version: 1, updatedAt: mode === 'all' ? at : updatedAt || at, quotes }, ok, failed };
}
