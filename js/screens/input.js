// 입력: 매수, 매도, 들어온 돈, 나간 돈, 옮김
import * as L from '../ledger.js';
import { fmtMoney } from '../format.js';
import { h, readNumber, shortDate } from '../ui.js';
import { itemPicker, resolvePicked } from './picker.js';

let type = 'buy';
const TYPES = [
  ['buy', '매수'],
  ['sell', '매도'],
  ['in', '들어온 돈'],
  ['out', '나간 돈'],
  ['move', '옮김'],
];

export function renderInput(main, ctx) {
  const seg = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': '입력 종류' },
    TYPES.map(([t, label]) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': type === t ? 'true' : 'false',
          onclick: () => {
            type = t;
            ctx.render();
          },
        },
        label,
      ),
    ),
  );
  const card = h('section', { class: 'card' }, seg);
  main.append(card);
  const form = h('form', { onsubmit: (e) => e.preventDefault() });
  card.append(form);
  if (!ctx.store.ledger.items.length && type !== 'move' && type !== 'in') {
    form.append(h('p', { class: 'notice' }, '먼저 실사 화면에서 처음 자료를 넣어 주세요. 새 항목은 여기서도 만들 수 있어요.'));
  }
  const builders = { buy: tradeForm, sell: tradeForm, in: oneForm, out: oneForm, move: moveForm };
  builders[type](form, ctx);
}

function commonFields(ctx) {
  const date = h('input', { type: 'date', value: ctx.today, max: ctx.today, required: true });
  const memo = h('input', { type: 'text', placeholder: '선택: 예) 배당, 생활비, 적금 가입' });
  return {
    date,
    memo,
    el: h('div', { class: 'field-row' }, h('div', null, h('label', null, '날짜'), date), h('div', null, h('label', null, '메모'), memo)),
  };
}

function need(n, what) {
  if (n == null) throw new L.LedgerError(`${what}을 넣어 주세요.`);
  if (Number.isNaN(n)) throw new L.LedgerError(`${what}이 숫자가 아니에요.`);
  if (n <= 0) throw new L.LedgerError(`${what}은 0보다 커야 해요.`);
  return n;
}

function checkDate(ctx, date) {
  if (!L.isDateStr(date)) throw new L.LedgerError('날짜를 골라 주세요.');
  if (date > ctx.today) throw new L.LedgerError('오늘 이후 날짜는 넣을 수 없어요.');
}

async function finish(ctx, ok) {
  if (!ok) return;
  const l = ctx.store.ledger;
  const last = l.entries.reduce((a, b) => (a && a.seq > b.seq ? a : b), null);
  const abs = L.absorbedBy(l, last);
  if (abs.length) {
    const d = abs.map((x) => x.countDate).sort().at(-1);
    ctx.toast(`${shortDate(d, ctx.today)} 실사보다 앞선 거래라 지금 잔액은 그대로예요(그 실사의 차이만 바뀌어요).`);
  }
  ctx.render();
}

// 같은 계좌의 현금 항목: 종목 시세와 같은 통화 먼저, 그다음 예수금
function cashOfAccount(ledger, accountId, preferCur = 'KRW') {
  const cands = ledger.items.filter((i) => i.accountId === accountId && !L.isQtyItem(i) && i.assetClass === '현금');
  const same = cands.filter((i) => (i.currency || 'KRW') === preferCur);
  const pool = same.length ? same : cands;
  return pool.find((i) => /예수금/.test(i.name)) || pool[0] || null;
}

// 고른 돈 항목의 통화(새 항목이면 적은 통화)
function pickedCurrency(ledger, picked) {
  if (!picked) return 'KRW';
  if (picked.create) return L.normalizeCurrency(picked.create.currency) || 'KRW';
  const it = ledger.items.find((i) => i.id === picked.itemId);
  return (it && it.currency) || 'KRW';
}

function tradeForm(form, ctx) {
  const buy = type === 'buy';
  const ledger = ctx.store.ledger;
  const entryId = L.newId('t'); // 응답이 끊겨 다시 눌러도 두 번 저장되지 않게
  const cashPick = itemPicker(ctx, { filter: (i) => !L.isQtyItem(i), newClass: '현금', label: buy ? '돈이 나간 곳' : '돈이 들어온 곳', onChange: () => setMode(byUnit) });
  cashPick.el.addEventListener('input', () => setMode(byUnit));
  const stockPick = itemPicker(ctx, {
    filter: (i, b) => L.isQtyItem(i) && (buy || b > 0),
    allowNew: buy,
    newClass: '국내주식',
    label: '종목',
    onChange: (id) => {
      const it = ledger.items.find((i) => i.id === id);
      if (it) {
        const q = (ctx.store.prices.quotes || {})[L.quoteKey(it)];
        const cur = (q && q.currency) || (L.lastTradePrice(ledger, it.id) || {}).currency || 'KRW';
        const cash = cashOfAccount(ledger, it.accountId, cur);
        if (cash) cashPick.set(cash.id);
      }
      setMode(byUnit);
    },
  });
  const qty = h('input', { type: 'text', inputmode: 'decimal', placeholder: '예: 10', oninput: () => update() });
  let byUnit = false;
  const money = h('input', { type: 'text', inputmode: 'decimal', oninput: () => update() });
  const moneyLabel = h('label');
  const modeSeg = h('div', { class: 'seg' });
  function setMode(u) {
    byUnit = u;
    const cur = pickedCurrency(ctx.store.ledger, cashPick.value());
    moneyLabel.textContent = byUnit
      ? `1주 단가 (${cur})`
      : buy
        ? `정산금액 (${cur}, 수수료·세금 포함, 실제로 나간 돈)`
        : `정산금액 (${cur}, 수수료·세금 뺀, 실제로 들어온 돈)`;
    for (const b of modeSeg.children) b.setAttribute('aria-pressed', String(b.dataset.u === String(byUnit)));
    update();
  }
  modeSeg.append(
    h('button', { type: 'button', 'data-u': 'false', onclick: () => setMode(false) }, '총액으로'),
    h('button', { type: 'button', 'data-u': 'true', onclick: () => setMode(true) }, '단가로'),
  );
  const preview = h('p', { class: 'muted small' });
  const common = commonFields(ctx);
  function total() {
    const q = readNumber(qty);
    const m = readNumber(money);
    if (q == null || m == null || Number.isNaN(q) || Number.isNaN(m)) return null;
    return byUnit ? q * m : m;
  }
  function update() {
    const t = total();
    const cur = pickedCurrency(ctx.store.ledger, cashPick.value());
    preview.textContent =
      t != null ? `${buy ? '나가는' : '들어오는'} 돈 ${fmtMoney(t, cur)}. 정산금액을 모르면 단가로 넣어도 돼요. 차이는 다음 실사 때 맞춰져요.` : '';
  }
  setMode(false);

  form.append(
    h('label', null, '종목'),
    stockPick.el,
    h('div', { class: 'field-row' }, h('div', null, h('label', null, buy ? '산 수량' : '판 수량'), qty), h('div', null, moneyLabel, money)),
    h('div', { class: 'row', style: 'margin-top:8px' }, modeSeg),
    preview,
    h('label', null, buy ? '돈이 나간 곳' : '돈이 들어온 곳'),
    cashPick.el,
    common.el,
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          class: 'btn primary',
          type: 'submit',
          onclick: async () => {
            let op;
            try {
              const date = common.date.value;
              const memo = common.memo.value.trim();
              checkDate(ctx, date);
              const q = need(readNumber(qty), '수량');
              const amount = need(total(), '금액');
              const s = stockPick.value();
              const c = cashPick.value();
              op = (l) => {
                let r = resolvePicked(l, s, '종목');
                const stockItemId = r.itemId;
                if (!L.isQtyItem(r.ledger.items.find((i) => i.id === stockItemId)))
                  throw new L.LedgerError('종목은 코드가 있는 항목이어야 해요(새 종목이면 코드를 넣어 주세요).');
                r = resolvePicked(r.ledger, c, '돈 항목');
                const tx = { date, stockItemId, cashItemId: r.itemId, qty: q, amount, memo };
                return L.addEntry(r.ledger, { ...(buy ? L.buyTx(tx) : L.sellTx(tx)), id: entryId });
              };
              op(ctx.store.ledger); // 미리 검사
            } catch (e) {
              ctx.toast(ctx.explain(e), 'bad');
              return;
            }
            finish(ctx, await ctx.save(op, `${buy ? '매수' : '매도'} 기록`, '저장했어요.'));
          },
        },
        '저장',
      ),
    ),
  );
}

function oneForm(form, ctx) {
  const incoming = type === 'in';
  const entryId = L.newId('t');
  const pick = itemPicker(ctx, { newClass: '현금', label: '항목', onChange: () => refresh() });
  const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '예: 150,000' });
  const unit = h('label');
  const labelFor = () => (pick.isQty() ? '수량' : `금액 (${pickedCurrency(ctx.store.ledger, pick.value())})`);
  const refresh = () => (unit.textContent = labelFor());
  // 새 항목 칸(코드·통화)을 바꿀 때도 수량/금액 표시를 맞춘다
  pick.el.addEventListener('input', refresh);
  pick.el.addEventListener('change', refresh);
  refresh();
  const common = commonFields(ctx);
  common.memo.placeholder = incoming ? '예: 배당, 이자, 월급' : '예: 생활비, 카드값, 보험료';
  form.append(
    h('p', { class: 'muted small' }, incoming ? '바깥에서 들어온 돈(배당·이자 등). 기록하지 않아도 실사 때 차이로 잡혀요.' : '바깥으로 나간 돈(생활비·카드값 등). 기록하지 않아도 실사 때 차이로 잡혀요.'),
    h('label', null, incoming ? '들어온 곳' : '나간 곳'),
    pick.el,
    unit,
    amount,
    common.el,
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          class: 'btn primary',
          type: 'submit',
          onclick: async () => {
            let op;
            try {
              const date = common.date.value;
              const memo = common.memo.value.trim();
              checkDate(ctx, date);
              const n = need(readNumber(amount), pick.isQty() ? '수량' : '금액');
              const p = pick.value();
              op = (l) => {
                const r = resolvePicked(l, p);
                const tx = { date, itemId: r.itemId, amount: n, memo };
                return L.addEntry(r.ledger, { ...(incoming ? L.inTx(tx) : L.outTx(tx)), id: entryId });
              };
              op(ctx.store.ledger);
            } catch (e) {
              ctx.toast(ctx.explain(e), 'bad');
              return;
            }
            finish(ctx, await ctx.save(op, incoming ? '들어온 돈 기록' : '나간 돈 기록', '저장했어요.'));
          },
        },
        '저장',
      ),
    ),
  );
}

function moveForm(form, ctx) {
  const entryId = L.newId('t');
  const from = itemPicker(ctx, { newClass: '현금', label: '보낸 곳' });
  const to = itemPicker(ctx, { newClass: '현금', label: '받은 곳' });
  const sent = h('input', { type: 'text', inputmode: 'decimal', placeholder: '예: 1,400,000' });
  const got = h('input', { type: 'text', inputmode: 'decimal', placeholder: '보낸 양과 같으면 비워 두세요' });
  const common = commonFields(ctx);
  common.memo.placeholder = '예: 정기예금 가입, 환전, 대출 상환';
  form.append(
    h('p', { class: 'muted small' }, '내 항목끼리 옮긴 것: 이체, 예금 가입·해지, 환전, 대출 받기(대출 → 통장)·갚기(통장 → 대출). 환전처럼 받은 양이 다르면 따로 적어요.'),
    h('label', null, '보낸 곳'),
    from.el,
    h('label', null, '보낸 양'),
    sent,
    h('label', null, '받은 곳'),
    to.el,
    h('label', null, '받은 양'),
    got,
    common.el,
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          class: 'btn primary',
          type: 'submit',
          onclick: async () => {
            let op;
            try {
              const date = common.date.value;
              const memo = common.memo.value.trim();
              checkDate(ctx, date);
              const a = need(readNumber(sent), '보낸 양');
              const gv = readNumber(got);
              const b = gv == null ? a : need(gv, '받은 양');
              const f = from.value();
              const t = to.value();
              op = (l) => {
                let r = resolvePicked(l, f, '보낸 곳');
                const fromItemId = r.itemId;
                r = resolvePicked(r.ledger, t, '받은 곳');
                if (r.itemId === fromItemId) throw new L.LedgerError('보낸 곳과 받은 곳이 같아요.');
                return L.addEntry(r.ledger, { ...L.moveTx({ date, fromItemId, fromAmount: a, toItemId: r.itemId, toAmount: b, memo }), id: entryId });
              };
              op(ctx.store.ledger);
            } catch (e) {
              ctx.toast(ctx.explain(e), 'bad');
              return;
            }
            finish(ctx, await ctx.save(op, '옮김 기록', '저장했어요.'));
          },
        },
        '저장',
      ),
    ),
  );
}

