// 실사: 목록이 실제와 맞는지 확인하고, 다른 것만 고친다. 엑셀 붙여넣기로 한꺼번에(처음 자료 포함).
import * as L from '../ledger.js';
import { fmtWon, fmtWonChange, changeClass, fmtNum } from '../format.js';
import { h, readNumber, fmtBalance, shortDate, accountName, unitWord } from '../ui.js';

let lastResult = null;
let countDate = null;

export function renderCount(main, ctx) {
  const { ledger } = ctx.store;
  const today = ctx.today;
  if (!countDate || countDate > today) countDate = today;
  if (lastResult) main.append(resultCard(ctx, lastResult));
  const empty = !ledger.items.length;
  if (!empty) main.append(checkCard(ctx));
  main.append(pasteCard(ctx, empty));
}

function resultCard(ctx, { date, ps }) {
  const today = ctx.today;
  const close = () => {
    lastResult = null;
    ctx.render();
  };
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'notice ok' }, `${shortDate(date, today)} 실사를 저장했어요.`),
    ps && ps.prevDate
      ? h(
          'div',
          null,
          h('div', { class: 'spread' }, h('span', null, `지난 실사(${shortDate(ps.prevDate, today)}) 이후 ${ps.days}일, 기록 안 한 현금 흐름`), h('b', { class: changeClass(ps.cash) }, fmtWonChange(ps.cash))),
          ps.cashPerMonth != null ? h('div', { class: 'spread small' }, h('span', { class: 'muted' }, '한 달로 치면'), h('span', null, fmtWonChange(ps.cashPerMonth))) : null,
          h('div', { class: 'spread small' }, h('span', { class: 'muted' }, '그 밖의 차이(채권 평가, 기록 안 한 매매 등)'), h('span', null, fmtWonChange(ps.other))),
          h('p', { class: 'muted small' }, '마이너스면 기록한 것보다 그만큼 더 쓴(또는 덜 들어온) 거예요.'),
        )
      : h('p', { class: 'muted' }, '첫 실사라 비교할 이전 실사가 없어요. 다음 실사부터 그 사이 현금 흐름(생활비 등)이 나와요.'),
    ps && ps.prevDate && ps.added ? h('div', { class: 'spread small' }, h('span', { class: 'muted' }, '새로 넣은 항목(흐름에서 뺌)'), h('span', null, fmtWon(ps.added))) : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, '닫기'), h('button', { class: 'btn primary', type: 'button', onclick: () => ((lastResult = null), ctx.go('home')) }, '현황 보기')),
  );
}

function checkCard(ctx) {
  const { ledger } = ctx.store;
  const today = ctx.today;
  const bal = L.computeBalances(ledger, { asOf: countDate });
  const date = h('input', {
    type: 'date',
    value: countDate,
    max: today,
    onchange: () => {
      if (L.isDateStr(date.value) && date.value <= today) {
        countDate = date.value;
        ctx.render();
      }
    },
  });
  const card = h(
    'section',
    { class: 'card' },
    h('h2', null, '실사: 목록이 실제와 맞는지 확인'),
    h(
      'p',
      { class: 'muted small' },
      '앱 값이 맞으면(대충 비슷해도) 칸을 비워 두고, 다르면 실제 값을 적으세요. 비운 칸은 앱 값 그대로 확인한 것으로 저장돼요. ',
      '증권 계좌 현금은 D+2 예수금(추정 예수금), 대출은 남은 빚을 양수로 적어요. 그날 거래를 먼저 입력한 뒤 실사하세요.',
    ),
    h('div', { class: 'row' }, h('label', { style: 'margin:0' }, '실사 날짜'), h('div', { style: 'width:180px' }, date)),
  );

  const rows = []; // { item, input }
  const byAcc = new Map();
  for (const it of ledger.items) {
    if ((bal.get(it.id) || 0) === 0) continue;
    if (!byAcc.has(it.accountId)) byAcc.set(it.accountId, []);
    byAcc.get(it.accountId).push(it);
  }
  const newRows = [];
  for (const acc of ledger.accounts) {
    const items = byAcc.get(acc.id);
    if (!items) continue;
    const body = h('tbody');
    for (const it of items) {
      const app = L.toShown(it, bal.get(it.id) || 0);
      const diff = h('td', { class: 'num' });
      const input = h('input', {
        type: 'text',
        inputmode: 'decimal',
        placeholder: plain(it, app),
        'aria-label': `${it.name} 실제 값`,
        oninput: () => {
          const v = readNumber(input);
          diff.textContent = '';
          diff.className = 'num';
          if (v == null) return;
          if (Number.isNaN(v)) {
            diff.textContent = '숫자가 아니에요';
            diff.classList.add('down');
            return;
          }
          const d = L.roundForItem(it, v - app);
          diff.textContent = d === 0 ? '같음' : (d > 0 ? '+' : '') + (L.isQtyItem(it) ? fmtNum(d, L.QTY_DECIMALS) + unitWord(it) : fmtNum(d, 2));
          diff.classList.add(changeClass(d));
        },
      });
      rows.push({ item: it, input });
      body.append(h('tr', null, h('td', null, it.name), h('td', { class: 'num' }, fmtBalance(it, bal.get(it.id) || 0)), h('td', null, input), diff));
    }
    const addBtn = h('button', { class: 'btn small', type: 'button' }, '+ 이 계좌에 항목 추가');
    const holder = h('div');
    addBtn.addEventListener('click', () => {
      const nr = newRow(acc.id);
      newRows.push(nr);
      holder.append(nr.el);
    });
    card.append(
      h('h3', null, acc.name),
      h('table', { class: 'fixed' }, h('thead', null, h('tr', null, h('th', null, '항목'), h('th', { class: 'num' }, '앱 값'), h('th', null, '실제 값'), h('th', { class: 'num' }, '차이'))), body),
      holder,
      h('div', { style: 'margin-top:6px' }, addBtn),
    );
  }
  const globalHolder = h('div');
  card.append(
    globalHolder,
    h(
      'div',
      { class: 'row', style: 'margin-top:12px' },
      h(
        'button',
        {
          class: 'btn small',
          type: 'button',
          onclick: () => {
            const nr = newRow(null);
            newRows.push(nr);
            globalHolder.append(nr.el);
          },
        },
        '+ 새 계좌·항목 추가',
      ),
    ),
  );

  const save = async () => {
    const d = countDate;
    let op;
    try {
      const entered = rows.map(({ item, input }) => {
        const v = readNumber(input);
        if (Number.isNaN(v)) throw new L.LedgerError(`${accountName(ledger, item.accountId)} · ${item.name}: 숫자가 아니에요.`);
        return { item, v };
      });
      const adds = newRows.map((nr) => nr.value());
      op = (l) => {
        const now = L.computeBalances(l, { asOf: d });
        const values = new Map();
        const push = (accountId, v) => {
          if (!values.has(accountId)) values.set(accountId, []);
          values.get(accountId).push(v);
        };
        let cur = l;
        for (const { item, v } of entered) {
          if (!cur.items.some((i) => i.id === item.id)) continue; // 그 사이 다른 곳에서 바뀐 경우
          push(item.accountId, { itemId: item.id, value: v == null ? now.get(item.id) || 0 : L.toInternal(item, v) });
        }
        for (const a of adds) {
          let accountId = a.accountId;
          if (!accountId) {
            if (!a.accountName) throw new L.LedgerError('새 계좌 이름을 넣어 주세요.');
            const r = L.ensureAccount(cur, a.accountName);
            cur = r.ledger;
            accountId = r.accountId;
          }
          if (!a.name) throw new L.LedgerError('새 항목 이름을 넣어 주세요.');
          if (a.value == null || Number.isNaN(a.value)) throw new L.LedgerError(`${a.name}: 실제 값을 넣어 주세요.`);
          const r = L.ensureItem(cur, { accountId, assetClass: a.assetClass, name: a.name, code: a.code, currency: a.currency });
          cur = r.ledger;
          const item = cur.items.find((i) => i.id === r.itemId);
          push(accountId, { itemId: item.id, value: L.toInternal(item, a.value) });
        }
        for (const [accountId, vals] of values) cur = L.addCount(cur, { accountId, date: d, values: vals });
        return cur;
      };
      op(ctx.store.ledger);
    } catch (e) {
      ctx.toast(ctx.explain(e), 'bad');
      return;
    }
    if (await ctx.save(op, `실사 ${d}`, null)) {
      lastResult = { date: d, ps: L.periodSummary(ctx.store.ledger, ctx.store.prices, d) };
      ctx.render();
      window.scrollTo(0, 0);
    }
  };
  card.append(h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, '실사 저장')));
  return card;
}

function plain(item, shown) {
  if (L.isQtyItem(item)) return fmtNum(shown, L.QTY_DECIMALS);
  return fmtNum(shown, L.currencyDecimals(item.currency || 'KRW'));
}

// 실사 중 새 항목 줄. accountId가 없으면 계좌 이름도 받는다.
function newRow(accountId) {
  const accName = h('input', { type: 'text', placeholder: '예: 국민은행 (홍길동)' });
  const cls = h('select');
  for (const c of L.ASSET_CLASSES) cls.append(h('option', { value: c }, c));
  cls.value = '현금';
  const name = h('input', { type: 'text', placeholder: '예: 정기예금, 삼성전자' });
  const code = h('input', { type: 'text', placeholder: '주식·코인만 (예: 005930)' });
  const cur = h('input', { type: 'text', value: 'KRW' });
  const value = h('input', { type: 'text', inputmode: 'decimal', placeholder: '실제 수량 또는 금액' });
  const el = h(
    'div',
    { class: 'newbox' },
    accountId ? null : h('div', null, h('label', null, '계좌 (이미 있는 이름이면 그 계좌에)'), accName),
    h('div', { class: 'field-row' }, h('div', null, h('label', null, '자산군'), cls), h('div', null, h('label', null, '이름'), name)),
    h('div', { class: 'field-row' }, h('div', null, h('label', null, '코드'), code), h('div', null, h('label', null, '통화(코드 없는 항목)'), cur), h('div', null, h('label', null, '실제 값'), value)),
  );
  return {
    el,
    value: () => ({
      accountId,
      accountName: accName.value.trim(),
      assetClass: cls.value,
      name: name.value.trim(),
      code: code.value.trim(),
      currency: cur.value.trim(),
      value: readNumber(value),
    }),
  };
}

function pasteCard(ctx, empty) {
  const today = ctx.today;
  const ta = h('textarea', { placeholder: '엑셀에서 표를 복사(Ctrl+C)해 여기에 붙여 넣으세요(Ctrl+V).', 'aria-label': '엑셀 표 붙여넣기' });
  const date = h('input', { type: 'date', value: countDate || today, max: today });
  const preview = h('div');
  const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, '붙여넣은 내용 저장');
  let parsed = { rows: [], errors: [] };
  const renderPreview = () => {
    parsed = L.parsePaste(ta.value);
    const ledger = ctx.store.ledger;
    preview.replaceChildren();
    if (parsed.errors.length) {
      preview.append(h('div', { class: 'notice bad' }, h('b', null, '고칠 줄이 있어요(저장 안 됨)'), parsed.errors.map((e) => h('div', null, e))));
    }
    if (parsed.rows.length) {
      let total = 0;
      const body = h('tbody');
      for (const r of parsed.rows) {
        const acc = L.findAccountByName(ledger, r.account);
        const exists = acc && L.findItem(ledger, { accountId: acc.id, code: r.code, name: r.name });
        if (r.code) {
          if (r.price && r.currency === 'KRW') total += r.amount * r.price;
        } else if (r.currency === 'KRW') total += r.assetClass === L.DEBT ? -Math.abs(r.amount) : r.amount;
        body.append(
          h(
            'tr',
            null,
            h('td', null, r.account),
            h('td', null, r.assetClass),
            h('td', null, r.name, r.code ? h('span', { class: 'sub-name' }, r.code) : null),
            h('td', { class: 'num' }, fmtNum(r.amount, 8)),
            h('td', { class: 'num hide-sm' }, r.price ? fmtNum(r.price, 4) : ''),
            h('td', null, h('span', { class: 'badge' + (exists ? '' : ' ok') }, exists ? '있는 항목' : '새 항목')),
          ),
        );
      }
      preview.append(
        h('p', { class: 'small' }, `${parsed.rows.length}줄 · 원화 합계 약 ${fmtWon(total)} (종목은 수량×단가, 단가 없는 종목과 외화는 빼고 셈, 부채는 뺌)`),
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', null, '계좌'), h('th', null, '자산군'), h('th', null, '이름'), h('th', { class: 'num' }, '수량·금액'), h('th', { class: 'num hide-sm' }, '단가'), h('th', null, ''))),
          body,
        ),
      );
    }
    saveBtn.disabled = !parsed.rows.length || parsed.errors.length > 0;
  };
  ta.addEventListener('input', renderPreview);
  saveBtn.addEventListener('click', async () => {
    const d = date.value;
    if (!L.isDateStr(d) || d > today) {
      ctx.toast('기준일을 골라 주세요(오늘까지).', 'bad');
      return;
    }
    const rows = parsed.rows;
    const op = (l) => L.applyPaste(l, rows, d);
    try {
      op(ctx.store.ledger);
    } catch (e) {
      ctx.toast(ctx.explain(e), 'bad');
      return;
    }
    if (await ctx.save(op, `붙여넣기 실사 ${d}`, null)) {
      lastResult = { date: d, ps: L.periodSummary(ctx.store.ledger, ctx.store.prices, d) };
      ctx.render();
      window.scrollTo(0, 0);
    }
  });
  return h(
    'section',
    { class: 'card' },
    h(
      'details',
      { open: empty },
      h('summary', null, h('b', null, empty ? '처음 자료 넣기: 엑셀 표 붙여넣기' : '엑셀 표 붙여넣기로 한꺼번에')),
      h(
        'p',
        { class: 'muted small' },
        '열 순서: 계좌 | 자산군 | 이름 | 코드 | 수량 또는 금액 | 통화(비우면 원화) | 단가(선택). 첫 줄이 제목이면 건너뛰어요. ',
        '숫자 칸은 셀 서식을 일반이나 숫자로 두세요(소수가 잘려 보이면 잘린 값이 들어와요). 이미 있는 항목은 값만 실사로 들어가요.',
      ),
      h('div', { class: 'row' }, h('label', { style: 'margin:0' }, '기준일'), h('div', { style: 'width:180px' }, date)),
      h('div', { style: 'margin-top:8px' }, ta),
      preview,
      h('div', { class: 'actions' }, saveBtn),
    ),
  );
}
