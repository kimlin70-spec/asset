// 보유 목록에서 항목을 눌렀을 때: 정보 보기, 이름·코드·통화 고치기, 값 바로잡기(액면분할·빠뜨린 입금 등)
import * as L from '../ledger.js';
import { fmtMoney } from '../format.js';
import { h, openDialog, readNumber, fmtBalance, accountName, kstTime } from '../ui.js';

const SOURCE_NAMES = { naver: '네이버', yahoo: '야후', upbit: '업비트', 'er-api': 'ExchangeRate-API' };

function allowedClasses(item) {
  if (item.assetClass === L.DEBT) return [L.DEBT];
  if (L.isQtyItem(item)) return item.assetClass === '코인' ? ['코인'] : L.ASSET_CLASSES.filter((c) => c !== '코인' && c !== L.DEBT);
  return L.ASSET_CLASSES.filter((c) => c !== L.DEBT);
}

export function openItemDialog(ctx, item) {
  const today = ctx.today;
  openDialog((close) => {
    const { ledger, prices } = ctx.store;
    const row = L.valuate(ledger, prices, { asOf: today }).find((r) => r.item.id === item.id);
    const qty = L.isQtyItem(item);
    const q = row && row.quote;

    const name = h('input', { type: 'text', value: item.name });
    const cls = h('select');
    for (const c of allowedClasses(item)) cls.append(h('option', { value: c }, c));
    cls.value = item.assetClass;
    const code = qty ? h('input', { type: 'text', value: item.code }) : null;
    const cur = qty ? null : h('input', { type: 'text', value: item.currency || 'KRW' });

    const saveInfo = async () => {
      const fields = { name: name.value, assetClass: cls.value };
      if (code) fields.code = code.value;
      if (cur) fields.currency = cur.value;
      let op;
      try {
        op = (l) => L.updateItem(l, item.id, fields);
        op(ctx.store.ledger);
      } catch (e) {
        ctx.toast(ctx.explain(e), 'bad');
        return;
      }
      if (await ctx.save(op, `항목 고치기: ${fields.name}`, '고쳤어요. 코드를 바꿨으면 다음 시세 갱신 때 반영돼요.')) {
        close();
        ctx.render();
      }
    };

    const fixValue = h('input', { type: 'text', inputmode: 'decimal', placeholder: row ? String(L.toShown(item, row.balance)) : '' });
    const fixDate = h('input', { type: 'date', value: today, max: today });
    const saveFix = async () => {
      let op;
      try {
        const v = readNumber(fixValue);
        if (v == null || Number.isNaN(v)) throw new L.LedgerError('바뀐 값을 숫자로 넣어 주세요.');
        if (!L.isDateStr(fixDate.value) || fixDate.value > today) throw new L.LedgerError('날짜를 골라 주세요(오늘까지).');
        op = (l) => L.addEntry(l, L.adjustTx(l, { date: fixDate.value, itemId: item.id, newShownValue: v, memo: '바로잡기' }));
        op(ctx.store.ledger);
      } catch (e) {
        ctx.toast(ctx.explain(e), 'bad');
        return;
      }
      if (await ctx.save(op, `바로잡기: ${item.name}`, '바로잡았어요.')) {
        close();
        ctx.render();
      }
    };

    return h(
      'div',
      null,
      h('h2', null, `${accountName(ledger, item.accountId)} · ${item.name}`),
      h(
        'table',
        { class: 'small' },
        h(
          'tbody',
          null,
          h('tr', null, h('td', null, '지금 값'), h('td', { class: 'num' }, row ? fmtBalance(item, row.balance) : '')),
          qty ? h('tr', null, h('td', null, '시세'), h('td', { class: 'num' }, row && row.price != null ? fmtMoney(row.price, row.currency) : '없음')) : null,
          q ? h('tr', null, h('td', null, '시세 출처'), h('td', { class: 'num' }, `${SOURCE_NAMES[q.source] || q.source || ''} ${q.name ? '· ' + q.name : ''}`)) : null,
          q ? h('tr', null, h('td', null, '마지막 성공'), h('td', { class: 'num' }, kstTime(q.at))) : null,
          q && q.ok === false ? h('tr', null, h('td', null, '최근 실패'), h('td', { class: 'num' }, `${kstTime(q.tried)} ${q.error || ''}`)) : null,
          row ? h('tr', null, h('td', null, '평가액(원)'), h('td', { class: 'num' }, fmtMoney(row.value, 'KRW'))) : null,
        ),
      ),
      h('h3', null, '이름·분류 고치기'),
      h('div', { class: 'field-row' }, h('div', null, h('label', null, '이름'), name), h('div', null, h('label', null, '자산군'), cls)),
      code ? h('div', null, h('label', null, '코드(시세 받을 때 씀)'), code) : null,
      cur ? h('div', null, h('label', null, '통화'), cur) : null,
      h('p', { class: 'muted small' }, '수량/금액 종류, 코인·부채 여부, 계좌는 바꿀 수 없어요. 잘못 만들었으면 아래에서 0으로 바로잡고 새로 만드세요.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: saveInfo }, '이름·분류 저장')),
      h('h3', null, '값 바로잡기'),
      h('p', { class: 'muted small' }, '액면분할·무상증자·빠뜨린 입금처럼 값만 틀렸을 때 실제 값을 넣으세요. 차이는 다음 실사 기간 요약에 함께 잡혀요.'),
      h('div', { class: 'field-row' }, h('div', null, h('label', null, qty ? '실제 수량' : item.assetClass === L.DEBT ? '실제 남은 빚' : '실제 금액'), fixValue), h('div', null, h('label', null, '날짜'), fixDate)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, '닫기'), h('button', { class: 'btn primary', type: 'button', onclick: saveFix }, '바로잡기 저장')),
    );
  });
}
