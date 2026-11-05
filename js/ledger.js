// 장부 계산 모듈 — 브라우저(앱)와 Node(Actions)가 같이 쓴다. DOM·네트워크 없음.
//
// 데이터 모양 (ledger.json)
//   { version, nextSeq,
//     accounts: [{ id, name }],
//     items:    [{ id, accountId, name, assetClass, code?, currency? }],
//     entries:  [ 거래 { id, seq, date, type: buy|sell|in|out|move|adjust, lines: [{ itemId, delta }], memo?, estimated? }
//               | 실사 { id, seq, date, type: 'count', accountId, values: [{ itemId, value }], memo? } ] }
//
// 규칙
//   - 코드가 있는 항목은 수량, 없는 항목은 금액.
//   - 잔액 = 그 항목의 마지막 실사값 + 그 뒤 거래. 실사에 적지 않은 항목은 그 실사의 영향을 받지 않는다.
//   - 순서: 날짜 → 같은 날짜에서는 거래 먼저, 실사 나중(실사 = 그날 끝의 실제 값) → 입력 순서(seq).
//   - 같은 계좌·같은 날짜의 실사는 하나뿐이다.
//   - 같은 계좌에서 같은 코드(코드가 없으면 같은 이름)는 같은 항목이다.
//   - 부채 항목은 내부에서 음수로 저장한다(빚 1억 = -100000000). 화면·입력에서만 양수로 보인다.
//   - 자산 = 플러스 평가액 합, 부채 = 마이너스 평가액 합(양수로), 순자산 = 자산 - 부채.
//   - 날짜는 기기 시간대와 상관없이 KST.

export const LEDGER_VERSION = 1;
export const ASSET_CLASSES = ['국내주식', '해외주식', '코인', '채권', '현금', '기타', '부채'];
export const DEBT = '부채';
export const TX_TYPES = {
  buy: '매수',
  sell: '매도',
  in: '들어온 돈',
  out: '나간 돈',
  move: '옮김',
  adjust: '바로잡기',
};
export const COUNT = 'count';
export const QTY_DECIMALS = 8;

// ---------- 날짜 (KST) ----------

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function kstDate(at = new Date()) {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

// to - from (일)
export function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
}

// ---------- 숫자 ----------

export function currencyDecimals(currency) {
  return currency === 'KRW' || currency === 'JPY' ? 0 : 2;
}

export function roundTo(x, decimals) {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** decimals;
  const r = (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
  return r === 0 ? 0 : r; // -0 없애기
}

export function isQtyItem(item) {
  return !!(item && item.code);
}

export function itemDecimals(item) {
  return isQtyItem(item) ? QTY_DECIMALS : currencyDecimals(item.currency || 'KRW');
}

export function roundForItem(item, x) {
  return roundTo(x, itemDecimals(item));
}

// "1,234", "-1,234.5", "(1,234)", "−1234", "₩1,000" 등을 숫자로. 못 읽으면 NaN.
export function parseNumber(input) {
  if (typeof input === 'number') return input;
  let t = String(input ?? '').trim().replace(/[,\s원₩$]/g, '').replace(/[−–]/g, '-');
  const paren = /^\((.*)\)$/.exec(t);
  if (paren) t = '-' + paren[1];
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return Number(t);
}

// 부채 항목: 화면 값(빚, 양수) <-> 내부 값(음수). 부호를 잘못 넣어도 빚으로 본다.
export function toInternal(item, shown) {
  return item && item.assetClass === DEBT ? -Math.abs(shown) : shown;
}

export function toShown(item, internal) {
  if (!(item && item.assetClass === DEBT)) return internal;
  return internal === 0 ? 0 : -internal;
}

// ---------- 코드와 시세 출처 ----------

// 통화: "원"·"WON"·"달러"처럼 적어도 알아듣는다. 비우면 원화.
const CURRENCY_ALIASES = {
  '': 'KRW', '원': 'KRW', WON: 'KRW', '₩': 'KRW', '원화': 'KRW',
  '달러': 'USD', '$': 'USD', 'US$': 'USD', '미국달러': 'USD',
  '엔': 'JPY', '엔화': 'JPY', '¥': 'JPY',
  '유로': 'EUR', '€': 'EUR',
  '위안': 'CNY', '위안화': 'CNY',
};

export function normalizeCurrency(input) {
  const t = String(input ?? '').trim().toUpperCase();
  if (t in CURRENCY_ALIASES) return CURRENCY_ALIASES[t];
  return /^[A-Z]{3}$/.test(t) ? t : null;
}

// 코드 정리: 대문자로, HTS 형식 A005930은 A를 떼고, 엑셀이 앞자리 0을 지운 국내 코드(5930)는 6자리로.
export function normalizeCode(code) {
  let c = String(code ?? '').trim().toUpperCase();
  if (/^A\d{6}$/.test(c)) c = c.slice(1); // HTS에서 쓰는 A005930 형식
  if (/^\d{1,5}$/.test(c)) c = c.padStart(6, '0'); // 엑셀이 앞자리 0을 지운 경우(5930)
  return c;
}

// 시세 키: 코드가 없으면 null(금액 항목). 자산군이 코인이면 코인,
// 점 없이 숫자로 시작하는 영문·숫자 6자리면 국내(005930, 0091C0), 그 밖은 해외 티커(AAPL, BRK-B, 7203.T).
export function quoteKey(item) {
  if (!isQtyItem(item)) return null;
  const code = normalizeCode(item.code);
  if (item.assetClass === '코인') return 'COIN:' + code;
  if (/^[0-9][0-9A-Z]{5}$/.test(code)) return 'KR:' + code;
  return 'INTL:' + code;
}

export function fxKey(currency) {
  return 'FX:' + currency;
}

export function fxRate(quotes, currency) {
  if (!currency || currency === 'KRW') return 1;
  const q = quotes && quotes[fxKey(currency)];
  return q && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
}

// ---------- 장부 기본 ----------

export function emptyLedger() {
  return { version: LEDGER_VERSION, nextSeq: 1, accounts: [], items: [], entries: [] };
}

export function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function indexById(list) {
  const m = new Map();
  for (const x of list || []) m.set(x.id, x);
  return m;
}

// 순서: 날짜 → 같은 날짜에서는 거래 먼저, 실사 나중(실사 = 그날 끝의 실제 값) → 입력 순서
export function sortEntries(entries) {
  const kind = (e) => (e.type === COUNT ? 1 : 0);
  return [...(entries || [])].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : kind(a) - kind(b) || a.seq - b.seq,
  );
}

// 잔액 계산. opts.asOf: 그 날짜까지(포함). opts.stopBefore: 그 기록 직전까지. opts.exclude: 그 기록은 빼고.
export function computeBalances(ledger, opts = {}) {
  const bal = new Map();
  for (const e of sortEntries(ledger.entries)) {
    if (opts.asOf && e.date > opts.asOf) break;
    if (opts.stopBefore && e.id === opts.stopBefore) break;
    if (opts.exclude && e.id === opts.exclude) continue;
    if (e.type === COUNT) {
      for (const v of e.values) bal.set(v.itemId, v.value);
    } else {
      for (const l of e.lines) bal.set(l.itemId, (bal.get(l.itemId) || 0) + l.delta);
    }
  }
  const items = indexById(ledger.items);
  for (const [id, x] of bal) {
    const item = items.get(id);
    bal.set(id, item ? roundForItem(item, x) : x);
  }
  return bal;
}

// 실사 한 건의 항목별 차이(보정액). 저장하지 않고 볼 때마다 계산한다.
export function countDiffs(ledger, countId) {
  const count = (ledger.entries || []).find((e) => e.id === countId && e.type === COUNT);
  if (!count) return [];
  const before = computeBalances(ledger, { stopBefore: countId });
  const items = indexById(ledger.items);
  return count.values.map((v) => {
    const item = items.get(v.itemId);
    const prev = before.get(v.itemId) || 0;
    const diff = v.value - prev;
    return { itemId: v.itemId, value: v.value, before: prev, diff: item ? roundForItem(item, diff) : diff };
  });
}

// 시세가 아직 없을 때 쓸 임시 단가: 그 항목이 들어간 마지막 매수·매도의 정산금액 ÷ 수량.
export function lastTradePrice(ledger, itemId, opts = {}) {
  const items = indexById(ledger.items);
  let found = null;
  for (const e of sortEntries(ledger.entries)) {
    if (opts.asOf && e.date > opts.asOf) break;
    if (e.type !== 'buy' && e.type !== 'sell') continue;
    const mine = e.lines.find((l) => l.itemId === itemId);
    const other = e.lines.find((l) => l.itemId !== itemId);
    if (!mine || !other || !mine.delta) continue;
    const otherItem = items.get(other.itemId);
    if (!otherItem || isQtyItem(otherItem)) continue;
    found = { price: Math.abs(other.delta / mine.delta), currency: otherItem.currency || 'KRW' };
  }
  return found;
}

// 항목별 평가. status: ok(시세 정상) | stale(마지막 갱신 실패, 이전 가격) | temp(매매 단가로 임시) | none(시세 없음) | nofx(환율 없음)
export function valuate(ledger, prices, opts = {}) {
  const quotes = (prices && prices.quotes) || {};
  const bal = computeBalances(ledger, opts);
  const accounts = indexById(ledger.accounts);
  return (ledger.items || []).map((item) => {
    const balance = bal.get(item.id) || 0;
    const row = {
      item,
      account: accounts.get(item.accountId) || null,
      balance,
      price: null,
      currency: item.currency || 'KRW',
      fx: null,
      value: 0,
      status: 'ok',
      quote: null,
    };
    if (isQtyItem(item)) {
      const q = quotes[quoteKey(item)];
      if (q && Number.isFinite(q.price) && q.price > 0) {
        row.price = q.price;
        row.currency = q.currency || 'KRW';
        row.quote = q;
        row.status = q.ok === false ? 'stale' : 'ok';
      } else {
        const t = lastTradePrice(ledger, item.id, opts);
        if (t) {
          row.price = t.price;
          row.currency = t.currency;
          row.status = 'temp';
        } else {
          row.status = 'none';
        }
      }
    }
    if (row.status !== 'none') {
      const fx = fxRate(quotes, row.currency);
      if (fx == null) {
        row.status = 'nofx';
      } else {
        row.fx = fx;
        const native = isQtyItem(item) ? balance * row.price : balance;
        row.value = Math.round(native * fx) || 0;
      }
    }
    return row;
  });
}

// Actions가 받을 시세: 잔액이 있는 수량 항목의 시세 키
export function neededQuoteKeys(ledger, opts = {}) {
  const bal = computeBalances(ledger, opts);
  const keys = new Set();
  for (const item of ledger.items || []) if (isQtyItem(item) && (bal.get(item.id) || 0) !== 0) keys.add(quoteKey(item));
  return [...keys].sort();
}

// 환율이 필요한 통화: 잔액이 있는 금액 항목의 통화 + 받아 온 시세의 통화(시세가 없으면 임시 단가의 통화). 원화 빼고.
// 그래서 시세를 먼저 받고 환율을 받는다. (원화로 산 미국 주식만 있어도 USD 환율을 받는다)
export function neededCurrencies(ledger, prices, opts = {}) {
  const quotes = (prices && prices.quotes) || {};
  const bal = computeBalances(ledger, opts);
  const set = new Set();
  for (const item of ledger.items || []) {
    if (!(bal.get(item.id) || 0)) continue;
    let cur;
    if (!isQtyItem(item)) cur = item.currency || 'KRW';
    else {
      const q = quotes[quoteKey(item)];
      cur = q && q.currency ? q.currency : (lastTradePrice(ledger, item.id, opts) || {}).currency;
    }
    if (cur && cur !== 'KRW') set.add(cur);
  }
  return [...set].sort();
}

// 이 거래가 어느 항목의 실사(같은 날짜 포함)보다 앞서서, 지금 잔액은 안 바뀌고 그 실사의 보정액만 바뀌는지.
// 화면에서 "실사 이전 거래라 지금 잔액은 그대로예요" 안내에 쓴다.
export function absorbedBy(ledger, entry) {
  if (!entry || entry.type === COUNT) return [];
  const out = [];
  for (const l of entry.lines || []) {
    let latest = null;
    for (const e of ledger.entries || []) {
      if (e.type !== COUNT || e.date < entry.date || e.id === entry.id) continue;
      if (e.values.some((v) => v.itemId === l.itemId) && (!latest || e.date > latest)) latest = e.date;
    }
    if (latest) out.push({ itemId: l.itemId, countDate: latest });
  }
  return out;
}

export function summarize(rows) {
  const byClass = {};
  const byAccount = {};
  let assets = 0;
  let debt = 0;
  for (const r of rows) {
    if (!r.value) continue;
    const cls = r.item.assetClass;
    byClass[cls] = (byClass[cls] || 0) + r.value;
    byAccount[r.item.accountId] = (byAccount[r.item.accountId] || 0) + r.value;
    if (r.value > 0) assets += r.value;
    else debt -= r.value;
  }
  return { net: assets - debt, assets, debt, byClass, byAccount };
}

// ---------- history (날짜별 합계) ----------

export function emptyHistory() {
  return { version: 1, days: {} };
}

export function historyEntry(ledger, prices, date) {
  const s = summarize(valuate(ledger, prices, { asOf: date }));
  return { net: s.net, assets: s.assets, debt: s.debt, byClass: s.byClass };
}

// 같은 날짜는 마지막 값으로 덮어쓴다.
export function putHistory(history, date, entry) {
  const h = history && history.days ? history : emptyHistory();
  return { ...h, days: { ...h.days, [date]: entry } };
}

// 전일 = 오늘 이전 마지막 기록, 지난달 말 = 전월(이전) 마지막 기록.
export function comparisons(history, today) {
  const days = (history && history.days) || {};
  const monthStart = today.slice(0, 8) + '01';
  let prevDay = null;
  let prevMonthEnd = null;
  for (const d of Object.keys(days).sort()) {
    if (d < today) prevDay = d;
    if (d < monthStart) prevMonthEnd = d;
  }
  return {
    prevDay: prevDay ? { date: prevDay, ...days[prevDay] } : null,
    prevMonthEnd: prevMonthEnd ? { date: prevMonthEnd, ...days[prevMonthEnd] } : null,
  };
}

// 그래프용: 최근 n일 일별 / 월별(각 달의 마지막 기록)
export function historySeries(history, { mode = 'daily', today, days = 90 } = {}) {
  const all = Object.keys((history && history.days) || {})
    .sort()
    .map((d) => ({ date: d, net: history.days[d].net }));
  if (mode === 'monthly') {
    const byMonth = new Map();
    for (const p of all) byMonth.set(p.date.slice(0, 7), p);
    return [...byMonth.values()];
  }
  if (!today) return all.slice(-days);
  return all.filter((p) => daysBetween(p.date, today) < days && p.date <= today);
}

// 계좌별 마지막 실사. 잔액이 남은 계좌 중 가장 오래된 것을 oldest로.
// 실사가 한 번도 없는 계좌는 첫 기록일부터 센다(date: null).
export function countStatus(ledger, today, balances = computeBalances(ledger, { asOf: today })) {
  const items = indexById(ledger.items);
  const last = new Map();
  const first = new Map();
  for (const e of ledger.entries || []) {
    if (e.type === COUNT) {
      const prev = last.get(e.accountId);
      if (!prev || e.date > prev) last.set(e.accountId, e.date);
    }
    const accountIds = e.type === COUNT ? [e.accountId] : (e.lines || []).map((l) => (items.get(l.itemId) || {}).accountId);
    for (const a of accountIds) {
      if (!a) continue;
      const f = first.get(a);
      if (!f || e.date < f) first.set(a, e.date);
    }
  }
  const active = new Set();
  for (const item of ledger.items || []) if ((balances.get(item.id) || 0) !== 0) active.add(item.accountId);
  let oldest = null;
  for (const accountId of active) {
    const date = last.get(accountId) || null;
    const since = date || first.get(accountId) || today;
    const cand = { accountId, date, days: Math.max(0, daysBetween(since, today)) };
    if (!oldest || cand.days > oldest.days) oldest = cand;
  }
  return { oldest, last };
}

// ---------- 장부 바꾸기 (항상 새 객체를 돌려준다: 충돌 시 최신 장부에 다시 적용할 수 있게) ----------

export function findAccountByName(ledger, name) {
  return (ledger.accounts || []).find((a) => a.name === name.trim()) || null;
}

export function ensureAccount(ledger, name) {
  const found = findAccountByName(ledger, name);
  if (found) return { ledger, accountId: found.id };
  const account = { id: newId('a'), name: name.trim() };
  return { ledger: { ...ledger, accounts: [...ledger.accounts, account] }, accountId: account.id };
}

export function cleanItemFields(fields) {
  const out = {
    accountId: fields.accountId,
    name: String(fields.name || '').trim(),
    assetClass: fields.assetClass,
  };
  const code = normalizeCode(fields.code);
  if (code && fields.assetClass !== DEBT) out.code = code;
  else out.currency = normalizeCurrency(fields.currency) || String(fields.currency).trim().toUpperCase();
  return out;
}

export function itemProblems(ledger, fields, selfId = null) {
  const p = [];
  if (!fields.name) p.push('이름을 넣어 주세요.');
  if (!ASSET_CLASSES.includes(fields.assetClass)) p.push('자산군을 골라 주세요.');
  if (!(ledger.accounts || []).some((a) => a.id === fields.accountId)) p.push('계좌를 골라 주세요.');
  if (fields.currency !== undefined && !/^[A-Z]{3}$/.test(fields.currency)) p.push('통화는 KRW, USD처럼 영문 3글자로 넣어 주세요.');
  const others = (ledger.items || []).filter((i) => i.id !== selfId && i.accountId === fields.accountId);
  if (others.some((i) => i.name === fields.name)) p.push('같은 계좌에 같은 이름의 항목이 이미 있어요.');
  const sameCode = fields.code && others.find((i) => i.code === fields.code);
  if (sameCode) p.push(`같은 계좌에 코드 ${fields.code} 항목(${sameCode.name})이 이미 있어요.`);
  return p;
}

// 같은 계좌에서 같은 코드(코드가 없으면 같은 이름)의 항목. 잔액 0으로 숨은 항목도 찾는다.
export function findItem(ledger, { accountId, code, name }) {
  const c = normalizeCode(code);
  const n = String(name || '').trim();
  return (
    (ledger.items || []).find((i) => i.accountId === accountId && (c ? i.code === c : !i.code && i.name === n)) || null
  );
}

// 있으면 그 항목을 쓰고, 없으면 만든다.
export function ensureItem(ledger, fields) {
  const clean = cleanItemFields(fields);
  const found = findItem(ledger, clean);
  if (found) return { ledger, itemId: found.id, existed: true };
  return { ...addItem(ledger, clean), existed: false };
}

export function addItem(ledger, fields) {
  const clean = cleanItemFields(fields);
  const problems = itemProblems(ledger, clean);
  if (problems.length) throw new LedgerError(problems.join(' '));
  const item = { id: newId('i'), ...clean };
  return { ledger: { ...ledger, items: [...ledger.items, item] }, itemId: item.id };
}

// 만든 뒤에 바꿀 수 없는 것: 수량/금액(코드 유무), 코인 여부(시세 출처), 부채 여부(부호), 계좌.
// 잘못 만들었으면 0으로 맞추고 새 항목을 만든다.
export function updateItem(ledger, id, fields) {
  const old = (ledger.items || []).find((i) => i.id === id);
  if (!old) throw new LedgerError('항목을 찾을 수 없어요.');
  const clean = cleanItemFields({ ...old, ...fields });
  const fixed = '잘못 만든 항목이면 0으로 맞추고 새 항목을 만들어 주세요.';
  if (!!old.code !== !!clean.code) throw new LedgerError('코드를 새로 넣거나 지울 수는 없어요(수량 항목과 금액 항목이 바뀌어요). ' + fixed);
  if (old.code && (old.assetClass === '코인') !== (clean.assetClass === '코인'))
    throw new LedgerError('코인과 다른 자산군 사이는 바꿀 수 없어요(시세 출처가 바뀌어요). ' + fixed);
  if ((old.assetClass === DEBT) !== (clean.assetClass === DEBT)) throw new LedgerError('부채와 다른 자산군 사이는 바꿀 수 없어요. ' + fixed);
  if (clean.accountId !== old.accountId) throw new LedgerError('항목의 계좌는 바꿀 수 없어요. 옮김으로 옮겨 주세요.');
  const problems = itemProblems(ledger, clean, id);
  if (problems.length) throw new LedgerError(problems.join(' '));
  return { ...ledger, items: ledger.items.map((i) => (i.id === id ? { id, ...clean } : i)) };
}

export class LedgerError extends Error {}

function cleanEntry(ledger, entry) {
  const items = indexById(ledger.items);
  if (!isDateStr(entry.date)) throw new LedgerError('날짜가 올바르지 않아요.');
  if (entry.type === COUNT) {
    if (!(ledger.accounts || []).some((a) => a.id === entry.accountId)) throw new LedgerError('계좌를 골라 주세요.');
    const seen = new Set();
    const values = (entry.values || []).map((v) => {
      const item = items.get(v.itemId);
      if (!item || item.accountId !== entry.accountId) throw new LedgerError('실사 항목이 그 계좌에 없어요.');
      if (seen.has(v.itemId)) throw new LedgerError('실사에 같은 항목이 두 번 있어요.');
      seen.add(v.itemId);
      if (!Number.isFinite(v.value)) throw new LedgerError(`${item.name}: 숫자를 넣어 주세요.`);
      return { itemId: v.itemId, value: roundForItem(item, v.value) };
    });
    if (!values.length) throw new LedgerError('실사할 항목이 없어요.');
    const out = { date: entry.date, type: COUNT, accountId: entry.accountId, values };
    if (entry.memo) out.memo = String(entry.memo);
    return out;
  }
  if (!TX_TYPES[entry.type]) throw new LedgerError('거래 종류가 올바르지 않아요.');
  const lines = (entry.lines || []).map((l) => {
    const item = items.get(l.itemId);
    if (!item) throw new LedgerError('항목을 골라 주세요.');
    if (!Number.isFinite(l.delta)) throw new LedgerError(`${item.name}: 숫자를 넣어 주세요.`);
    return { itemId: l.itemId, delta: roundForItem(item, l.delta) };
  });
  if (!lines.length || lines.every((l) => l.delta === 0)) throw new LedgerError('금액이나 수량을 넣어 주세요.');
  const out = { date: entry.date, type: entry.type, lines };
  if (entry.memo) out.memo = String(entry.memo);
  if (entry.estimated) out.estimated = true;
  return out;
}

function assertOneCountPerDay(ledger, clean, selfId) {
  if (clean.type !== COUNT) return;
  const dup = (ledger.entries || []).find(
    (e) => e.type === COUNT && e.id !== selfId && e.accountId === clean.accountId && e.date === clean.date,
  );
  if (dup) throw new LedgerError('그 날짜에 이 계좌 실사가 이미 있어요. 그 실사를 고쳐 주세요.');
}

export function addEntry(ledger, entry) {
  const clean = cleanEntry(ledger, entry);
  assertOneCountPerDay(ledger, clean, null);
  const seq = ledger.nextSeq || 1;
  const id = newId(clean.type === COUNT ? 'c' : 't');
  return { ...ledger, nextSeq: seq + 1, entries: [...ledger.entries, { id, seq, ...clean }] };
}

// 고쳐도 입력 순서(seq)는 그대로 둔다.
export function updateEntry(ledger, id, entry) {
  const old = (ledger.entries || []).find((e) => e.id === id);
  if (!old) throw new LedgerError('기록을 찾을 수 없어요. 다른 곳에서 지웠을 수 있어요.');
  const clean = cleanEntry(ledger, { ...entry, type: entry.type || old.type });
  assertOneCountPerDay(ledger, clean, id);
  return { ...ledger, entries: ledger.entries.map((e) => (e.id === id ? { id, seq: old.seq, ...clean } : e)) };
}

export function removeEntry(ledger, id) {
  return { ...ledger, entries: ledger.entries.filter((e) => e.id !== id) };
}

// 그 계좌·날짜의 실사가 있으면 값을 합쳐 고치고(같은 항목은 새 값), 없으면 새로 만든다.
export function upsertCount(ledger, { accountId, date, values, memo }) {
  const existing = (ledger.entries || []).find((e) => e.type === COUNT && e.accountId === accountId && e.date === date);
  if (!existing) return addEntry(ledger, { date, type: COUNT, accountId, values, memo });
  const merged = new Map(existing.values.map((v) => [v.itemId, v.value]));
  for (const v of values) merged.set(v.itemId, v.value);
  return updateEntry(ledger, existing.id, {
    date,
    type: COUNT,
    accountId,
    values: [...merged].map(([itemId, value]) => ({ itemId, value })),
    memo: existing.memo || memo,
  });
}

// ---------- 입력 화면용 거래 만들기 (금액·수량은 모두 양수로 받는다) ----------

export function buyTx({ date, cashItemId, amount, stockItemId, qty, estimated, memo }) {
  return {
    date,
    type: 'buy',
    lines: [
      { itemId: cashItemId, delta: -Math.abs(amount) },
      { itemId: stockItemId, delta: Math.abs(qty) },
    ],
    estimated,
    memo,
  };
}

export function sellTx({ date, stockItemId, qty, cashItemId, amount, estimated, memo }) {
  return {
    date,
    type: 'sell',
    lines: [
      { itemId: stockItemId, delta: -Math.abs(qty) },
      { itemId: cashItemId, delta: Math.abs(amount) },
    ],
    estimated,
    memo,
  };
}

// 들어온 돈 / 나간 돈. 부채 항목에 들어오면 빚이 줄고, 나가면 빚이 는다.
export function inTx({ date, itemId, amount, memo }) {
  return { date, type: 'in', lines: [{ itemId, delta: Math.abs(amount) }], memo };
}

export function outTx({ date, itemId, amount, memo }) {
  return { date, type: 'out', lines: [{ itemId, delta: -Math.abs(amount) }], memo };
}

// 옮김: 보낸 곳에서 빼고 받은 곳에 더한다. 대출 받기 = 대출 -> 통장, 갚기 = 통장 -> 대출.
export function moveTx({ date, fromItemId, fromAmount, toItemId, toAmount, memo }) {
  return {
    date,
    type: 'move',
    lines: [
      { itemId: fromItemId, delta: -Math.abs(fromAmount) },
      { itemId: toItemId, delta: Math.abs(toAmount) },
    ],
    memo,
  };
}

// 바로잡기: 항목 하나를 새 값(화면 값)으로 맞춘다. 그 날짜까지(그날 거래 포함) 잔액과의 차이를 기록.
// 기록에서 고칠 때는 excludeId에 그 바로잡기 id를 넘겨 자기 자신을 빼고 다시 계산한다.
export function adjustTx(ledger, { date, itemId, newShownValue, memo, excludeId }) {
  const item = (ledger.items || []).find((i) => i.id === itemId);
  if (!item) throw new LedgerError('항목을 골라 주세요.');
  const current = computeBalances(ledger, { asOf: date, exclude: excludeId }).get(itemId) || 0;
  const delta = roundForItem(item, toInternal(item, newShownValue) - current);
  return { date, type: 'adjust', lines: [{ itemId, delta }], memo };
}

// ---------- 엑셀 붙여넣기 ----------
// 열: 계좌 | 자산군 | 이름 | 코드 | 수량 또는 금액 | 통화(비우면 원화)

export function parsePaste(text) {
  const rows = [];
  const errors = [];
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '');
  const seen = new Set();
  lines.forEach((line, i) => {
    const n = i + 1;
    const cells = line.split('\t').map((c) => c.trim());
    if (cells.length < 5) {
      errors.push(`${n}번째 줄: 칸이 모자라요. 엑셀에서 6칸(계좌, 자산군, 이름, 코드, 수량·금액, 통화)을 복사해 주세요.`);
      return;
    }
    const [account, assetClass, name, code, amountText, currencyText = ''] = cells;
    const amount = parseNumber(amountText);
    if (i === 0 && Number.isNaN(amount)) return; // 제목 줄
    const rowErrors = [];
    if (!account) rowErrors.push('계좌가 비었어요');
    if (!ASSET_CLASSES.includes(assetClass)) rowErrors.push(`자산군은 ${ASSET_CLASSES.join('·')} 중 하나여야 해요`);
    if (!name) rowErrors.push('이름이 비었어요');
    if (Number.isNaN(amount)) rowErrors.push('수량·금액이 숫자가 아니에요');
    if (assetClass === DEBT && code) rowErrors.push('부채는 코드를 비워 주세요');
    const currency = normalizeCurrency(currencyText);
    if (!currency) rowErrors.push('통화는 KRW, USD처럼 영문 3글자로 적어 주세요');
    const key = account + '\u0000' + name;
    if (seen.has(key)) rowErrors.push('같은 계좌·이름이 두 번 나와요');
    seen.add(key);
    if (rowErrors.length) {
      errors.push(`${n}번째 줄: ${rowErrors.join(', ')}.`);
      return;
    }
    rows.push({ account, assetClass, name, code: normalizeCode(code), amount, currency });
  });
  return { rows, errors };
}

// 붙여넣은 줄을 장부에 넣는다. 계좌·항목은 없으면 만들고(이미 있으면 그 항목의 정보는 건드리지 않음),
// 값은 계좌별 실사로 저장한다(같은 날짜 실사가 있으면 합친다).
export function applyPaste(ledger, rows, date) {
  if (!isDateStr(date)) throw new LedgerError('기준일이 올바르지 않아요.');
  let l = ledger;
  const byAccount = new Map();
  for (const r of rows) {
    const acc = ensureAccount(l, r.account);
    l = acc.ledger;
    const res = ensureItem(l, { accountId: acc.accountId, name: r.name, assetClass: r.assetClass, code: r.code, currency: r.currency });
    l = res.ledger;
    const item = l.items.find((i) => i.id === res.itemId);
    if (!byAccount.has(acc.accountId)) byAccount.set(acc.accountId, new Map());
    const values = byAccount.get(acc.accountId);
    if (values.has(item.id)) throw new LedgerError(`${r.account}의 ${r.name}: 같은 항목이 두 번 나와요(코드가 같은지 확인해 주세요).`);
    values.set(item.id, toInternal(item, r.amount));
  }
  for (const [accountId, values] of byAccount) {
    l = upsertCount(l, { accountId, date, values: [...values].map(([itemId, value]) => ({ itemId, value })), memo: '붙여넣기' });
  }
  return l;
}

// ---------- 저장 전 검사 ----------

export function validateLedger(ledger) {
  const p = [];
  if (!ledger || typeof ledger !== 'object') return ['장부 형식이 아니에요.'];
  if (ledger.version !== LEDGER_VERSION) p.push(`장부 버전이 ${ledger.version}이에요(앱은 ${LEDGER_VERSION}).`);
  for (const key of ['accounts', 'items', 'entries']) if (!Array.isArray(ledger[key])) p.push(`${key}가 없어요.`);
  if (p.length) return p;
  const accounts = indexById(ledger.accounts);
  const items = indexById(ledger.items);
  const ids = new Set();
  for (const x of [...ledger.accounts, ...ledger.items, ...ledger.entries]) {
    if (!x.id || ids.has(x.id)) p.push(`ID가 비었거나 겹쳐요: ${x.id}`);
    ids.add(x.id);
  }
  for (const i of ledger.items) {
    if (!accounts.has(i.accountId)) p.push(`항목 ${i.name}의 계좌가 없어요.`);
    if (!ASSET_CLASSES.includes(i.assetClass)) p.push(`항목 ${i.name}의 자산군이 이상해요.`);
  }
  const seqs = new Set();
  for (const e of ledger.entries) {
    if (!isDateStr(e.date)) p.push(`기록 ${e.id}의 날짜가 이상해요.`);
    if (!Number.isInteger(e.seq) || seqs.has(e.seq) || e.seq >= ledger.nextSeq) p.push(`기록 ${e.id}의 순서 번호가 이상해요.`);
    seqs.add(e.seq);
    const refs = e.type === COUNT ? e.values : e.lines;
    if (!Array.isArray(refs)) {
      p.push(`기록 ${e.id}의 내용이 없어요.`);
      continue;
    }
    for (const r of refs) {
      if (!items.has(r.itemId)) p.push(`기록 ${e.id}가 없는 항목을 가리켜요.`);
      const n = e.type === COUNT ? r.value : r.delta;
      if (!Number.isFinite(n)) p.push(`기록 ${e.id}에 숫자가 아닌 값이 있어요.`);
    }
    if (e.type === COUNT && !accounts.has(e.accountId)) p.push(`실사 ${e.id}의 계좌가 없어요.`);
  }
  const countDays = new Set();
  for (const e of ledger.entries) {
    if (e.type !== COUNT) continue;
    const k = e.accountId + '|' + e.date;
    if (countDays.has(k)) p.push(`같은 계좌·같은 날짜의 실사가 둘이에요: ${e.date}`);
    countDays.add(k);
  }
  return p;
}
