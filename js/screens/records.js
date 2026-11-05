// 기록: 거래·실사 목록(최근순), 고치기·지우기
import * as L from '../ledger.js';
import { fmtNum, fmtMoney } from '../format.js';
import { h, shortDate, accountName, unitWord, confirmBox, openDialog, readNumber } from '../ui.js';

let shownCount = 50;

export function renderRecords(main, ctx) {
  const { ledger } = ctx.store;
  const today = ctx.today;
  const items = new Map(ledger.items.map((i) => [i.id, i]));
  const list = L.sortEntries(ledger.entries).reverse();
  const card = h('section', { class: 'card' }, h('h2', null, `기록 ${list.length}건`));
  if (!list.length) card.append(h('p', { class: 'muted' }, '아직 기록이 없어요.'));
  for (const e of list.slice(0, shownCount)) card.append(recordEl(ctx, e, items, today));
  if (list.length > shownCount) {
    card.append(
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            shownCount += 50;
            ctx.render();
          },
        },
        '더 보기',
      ),
    );
  }
  main.append(card);
}

// 화면에 보일 증감: 부채 항목은 빚 기준(빚이 늘면 +)
function deltaText(item, delta) {
  if (!item) return String(delta);
  const shown = item.assetClass === L.DEBT ? -delta : delta;
  const sign = shown > 0 ? '+' : shown < 0 ? '−' : '';
  const abs = Math.abs(shown);
  const body = L.isQtyItem(item) ? fmtNum(abs, L.QTY_DECIMALS) + unitWord(item) : fmtMoney(abs, item.currency || 'KRW');
  return (item.assetClass === L.DEBT ? '빚 ' : '') + sign + body;
}

function valueText(item, internal) {
  if (!item) return String(internal);
  const shown = L.toShown(item, internal);
  return L.isQtyItem(item) ? fmtNum(shown, L.QTY_DECIMALS) + unitWord(item) : fmtMoney(shown, item.currency || 'KRW');
}

function label(ctx, item) {
  return item ? `${accountName(ctx.store.ledger, item.accountId)} · ${item.name}` : '(지운 항목)';
}

function recordEl(ctx, e, items, today) {
  const isCount = e.type === L.COUNT;
  const title = isCount ? `실사 · ${accountName(ctx.store.ledger, e.accountId)}` : L.TX_TYPES[e.type] || e.type;
  const body = h('div', { class: 'lines' });
  if (isCount) {
    const diffs = L.countDiffs(ctx.store.ledger, e.id);
    const firsts = diffs.filter((d) => d.first);
    const changed = diffs.filter((d) => !d.first && d.diff !== 0);
    const parts = [];
    if (firsts.length) parts.push(`처음 입력 ${firsts.length}개`);
    if (diffs.length - firsts.length) parts.push(changed.length ? `차이 ${changed.length}개` : '모두 같음');
    body.append(h('div', null, h('span', null, `항목 ${diffs.length}개`), h('span', null, parts.join(' · '))));
    if (changed.length) {
      body.append(
        h(
          'details',
          null,
          h('summary', null, '차이 보기'),
          changed.map((d) => {
            const it = items.get(d.itemId);
            return h('div', null, h('span', null, it ? it.name : '?'), h('span', { class: 'num' }, `${valueText(it, d.before)} → ${valueText(it, d.value)} (${deltaText(it, d.diff)})`));
          }),
        ),
      );
    }
  } else {
    for (const l of e.lines) {
      const it = items.get(l.itemId);
      body.append(h('div', null, h('span', null, label(ctx, it)), h('span', { class: 'num' }, deltaText(it, l.delta))));
    }
  }
  return h(
    'div',
    { class: 'rec' },
    h('div', { class: 'spread' }, h('span', null, h('b', null, `${shortDate(e.date, today)} ${title}`), e.memo ? h('span', { class: 'muted' }, ` · ${e.memo}`) : null), h('span', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => editDialog(ctx, e, items) }, '고치기'), h('button', { class: 'btn small danger', type: 'button', onclick: () => remove(ctx, e) }, '지우기'))),
    body,
  );
}

async function remove(ctx, e) {
  const isCount = e.type === L.COUNT;
  const ok = await confirmBox('이 기록을 지울까요?', isCount ? '실사를 지우면 이 계좌의 잔액이 바뀔 수 있어요(처음 붙여넣은 실사라면 시작 잔액이 사라져요).' : '', '지우기', true);
  if (!ok) return;
  if (await ctx.save((l) => L.removeEntry(l, e.id), '기록 지우기', '지웠어요.')) ctx.render();
}

function editDialog(ctx, e, items) {
  const isCount = e.type === L.COUNT;
  openDialog((close) => {
    const date = h('input', { type: 'date', value: e.date, max: ctx.today });
    const memo = h('input', { type: 'text', value: e.memo || '' });
    const fields = [];
    const rows = h('div');
    if (isCount) {
      for (const v of e.values) {
        const it = items.get(v.itemId);
        const input = h('input', { type: 'text', inputmode: 'decimal', value: String(L.toShown(it, v.value)) });
        fields.push({ v, it, input });
        rows.append(h('label', null, it ? it.name : '?'), input);
      }
    } else {
      for (const l of e.lines) {
        const it = items.get(l.itemId);
        const input = h('input', { type: 'text', inputmode: 'decimal', value: String(Math.abs(l.delta)) });
        fields.push({ l, it, input });
        rows.append(h('label', null, `${label(ctx, it)} (${l.delta < 0 ? '빠짐' : '늘어남'})`), input);
      }
    }
    const save = async () => {
      let op;
      try {
        if (!L.isDateStr(date.value) || date.value > ctx.today) throw new L.LedgerError('날짜를 골라 주세요(오늘까지).');
        const read = (input, name) => {
          const n = readNumber(input);
          if (n == null || Number.isNaN(n)) throw new L.LedgerError(`${name}: 숫자를 넣어 주세요.`);
          return n;
        };
        let next;
        if (isCount) {
          const values = fields.map(({ v, it, input }) => ({ ...v, value: L.toInternal(it, read(input, it ? it.name : '?')) }));
          next = { date: date.value, type: L.COUNT, accountId: e.accountId, values, memo: memo.value.trim() };
        } else {
          const lines = fields.map(({ l, it, input }) => ({ itemId: l.itemId, delta: Math.sign(l.delta || 1) * Math.abs(read(input, it ? it.name : '?')) }));
          next = { date: date.value, type: e.type, lines, memo: memo.value.trim() };
        }
        op = (l) => L.updateEntry(l, e.id, next);
        op(ctx.store.ledger);
      } catch (err) {
        ctx.toast(ctx.explain(err), 'bad');
        return;
      }
      if (await ctx.save(op, '기록 고치기', '고쳤어요.')) {
        close();
        if (!isCount) {
          const updated = ctx.store.ledger.entries.find((x) => x.id === e.id);
          const abs = L.absorbedBy(ctx.store.ledger, updated);
          if (abs.length) ctx.toast('실사보다 앞선 거래라 지금 잔액은 그대로예요(그 실사의 차이만 바뀌어요).');
        }
        ctx.render();
      }
    };
    return h(
      'form',
      { onsubmit: (ev) => ev.preventDefault() },
      h('h2', null, isCount ? '실사 고치기' : `${L.TX_TYPES[e.type] || e.type} 고치기`),
      h('div', { class: 'field-row' }, h('div', null, h('label', null, '날짜'), date), h('div', null, h('label', null, '메모'), memo)),
      rows,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, '취소'), h('button', { class: 'btn primary', type: 'submit', onclick: save }, '저장')),
    );
  });
}
