// 항목 고르기(+ 새 항목·새 계좌 만들기). 어느 입력 화면에서나 같은 모양.
import * as L from '../ledger.js';
import { h, fmtBalance } from '../ui.js';

const NEW = '__new__';
const NEW_ACCOUNT = '__newacc__';

// opts.filter(item, balance) → 목록에 넣을지, opts.newClass: 새 항목 기본 자산군, opts.qty: 새 항목에 코드 칸을 먼저 보일지
export function itemPicker(ctx, opts = {}) {
  const ledger = ctx.store.ledger;
  const bal = L.computeBalances(ledger, { asOf: ctx.today });
  const filter = opts.filter || (() => true);
  const select = h('select', { 'aria-label': opts.label || '항목' });
  select.append(h('option', { value: '' }, '— 고르세요 —'));
  for (const acc of ledger.accounts) {
    const items = ledger.items.filter((i) => i.accountId === acc.id && filter(i, bal.get(i.id) || 0));
    if (!items.length) continue;
    const g = h('optgroup', { label: acc.name });
    for (const it of items) g.append(h('option', { value: it.id }, `${it.name} (${fmtBalance(it, bal.get(it.id) || 0)})`));
    select.append(g);
  }
  if (opts.allowNew !== false) select.append(h('option', { value: NEW }, '+ 새 항목 만들기…'));

  // 새 항목 칸
  const accSel = h('select');
  for (const acc of ledger.accounts) accSel.append(h('option', { value: acc.id }, acc.name));
  accSel.append(h('option', { value: NEW_ACCOUNT }, '+ 새 계좌…'));
  const accName = h('input', { type: 'text', placeholder: '예: 국민은행 (홍길동)' });
  const accNameWrap = h('div', { hidden: ledger.accounts.length > 0 }, h('label', null, '새 계좌 이름'), accName);
  if (!ledger.accounts.length) accSel.value = NEW_ACCOUNT;
  accSel.addEventListener('change', () => (accNameWrap.hidden = accSel.value !== NEW_ACCOUNT));
  const clsSel = h('select');
  for (const c of L.ASSET_CLASSES) clsSel.append(h('option', { value: c }, c));
  clsSel.value = opts.newClass || '현금';
  const name = h('input', { type: 'text', placeholder: '예: 예수금, 삼성전자, 정기예금' });
  const code = h('input', { type: 'text', placeholder: '주식 005930 · 해외 AAPL · 코인 BTC (현금·예금이면 비움)' });
  const cur = h('input', { type: 'text', value: 'KRW', placeholder: 'KRW' });
  const curWrap = h('div', null, h('label', null, '통화 (코드가 없는 항목만)'), cur);
  const syncCur = () => (curWrap.hidden = !!code.value.trim());
  code.addEventListener('input', syncCur);
  const newBox = h(
    'div',
    { class: 'newbox', hidden: true },
    h('label', null, '계좌'),
    accSel,
    accNameWrap,
    h('div', { class: 'field-row' }, h('div', null, h('label', null, '자산군'), clsSel), h('div', null, h('label', null, '이름'), name)),
    h('div', { class: 'field-row' }, h('div', null, h('label', null, '코드 (시세를 받을 때만)'), code), curWrap),
  );
  select.addEventListener('change', () => {
    newBox.hidden = select.value !== NEW;
    if (opts.onChange) opts.onChange(select.value);
  });

  const el = h('div', null, select, newBox);
  return {
    el,
    select,
    // 고른 것: { itemId } 또는 { create: {...} }. 비었으면 null
    value() {
      if (select.value === NEW) {
        const accountNew = accSel.value === NEW_ACCOUNT;
        return {
          create: {
            accountId: accountNew ? null : accSel.value,
            accountName: accountNew ? accName.value.trim() : null,
            assetClass: clsSel.value,
            name: name.value.trim(),
            code: code.value.trim(),
            currency: cur.value.trim(),
          },
        };
      }
      return select.value ? { itemId: select.value } : null;
    },
    set(itemId) {
      select.value = itemId;
      newBox.hidden = true;
    },
    // 새 항목이면 그 자리에서 만들어지는지(수량 항목인지) 미리 알기
    isQty(ledgerNow = ctx.store.ledger) {
      const v = this.value();
      if (!v) return false;
      if (v.create) return !!L.normalizeCode(v.create.code) && v.create.assetClass !== L.DEBT;
      const it = ledgerNow.items.find((i) => i.id === v.itemId);
      return L.isQtyItem(it);
    },
  };
}

// 저장할 때(op 안에서): 고른 것을 실제 항목 id로. 새 항목·새 계좌는 여기서 만든다.
export function resolvePicked(ledger, picked, what = '항목') {
  if (!picked) throw new L.LedgerError(`${what}을 골라 주세요.`);
  if (picked.itemId) return { ledger, itemId: picked.itemId };
  const c = picked.create;
  let l = ledger;
  let accountId = c.accountId;
  if (!accountId) {
    if (!c.accountName) throw new L.LedgerError('새 계좌 이름을 넣어 주세요.');
    const r = L.ensureAccount(l, c.accountName);
    l = r.ledger;
    accountId = r.accountId;
  }
  if (!c.name) throw new L.LedgerError(`새 ${what}의 이름을 넣어 주세요.`);
  const r = L.ensureItem(l, { accountId, assetClass: c.assetClass, name: c.name, code: c.code, currency: c.currency });
  return { ledger: r.ledger, itemId: r.itemId };
}
