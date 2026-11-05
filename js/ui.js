// 화면 도우미. 글자는 모두 textContent로 넣는다(innerHTML 쓰지 않음).
import * as L from './ledger.js';
import { fmtMoney, fmtNum } from './format.js';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

let toastBox = null;
export function toast(message, kind = '') {
  toastBox = toastBox || document.getElementById('toast');
  const div = h('div', { class: kind }, message);
  toastBox.append(div);
  setTimeout(() => div.remove(), kind === 'bad' ? 7000 : 4000);
}

// 확인 창. 확인을 누르면 true
export function confirmBox(title, message, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    const dlg = h(
      'dialog',
      null,
      h('h2', null, title),
      message ? h('p', null, message) : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('no') }, '취소'),
        h('button', { class: 'btn primary' + (danger ? ' danger' : ''), type: 'button', onclick: () => dlg.close('yes') }, okLabel),
      ),
    );
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(dlg.returnValue === 'yes');
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// 대화상자 열기. build(close)가 내용을 돌려준다.
export function openDialog(build) {
  const dlg = h('dialog');
  const close = () => dlg.close();
  dlg.append(build(close));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// 숫자 입력 읽기: "1,234", "₩1,000" 등. 비었으면 null, 못 읽으면 NaN
export function readNumber(input) {
  const t = String(input && input.value != null ? input.value : input || '').trim();
  if (t === '') return null;
  return L.parseNumber(t);
}

// 입력 칸에 미리 채울 숫자(쉼표 없이, 지수 표기 없이): 0.0000003 → "0.0000003"
export function plainNumber(item, x) {
  return fmtNum(x, L.itemDecimals(item || {})).replace(/,/g, '').replace('−', '-');
}

export function unitWord(item) {
  if (!L.isQtyItem(item)) return '';
  return item.assetClass === '코인' ? '개' : '주';
}

// 항목의 잔액을 화면 값으로(부채는 양수)
export function fmtBalance(item, internal) {
  const shown = L.toShown(item, internal);
  if (L.isQtyItem(item)) return fmtNum(shown, L.QTY_DECIMALS) + unitWord(item);
  return fmtMoney(shown, item.currency || 'KRW');
}

export function accountName(ledger, accountId) {
  const a = (ledger.accounts || []).find((x) => x.id === accountId);
  return a ? a.name : '(계좌 없음)';
}

export function itemLabel(ledger, item) {
  return `${accountName(ledger, item.accountId)} · ${item.name}`;
}

export function dateInput(value, max) {
  return h('input', { type: 'date', value, max, required: true });
}

// 날짜 보기: 2026-11-05 → 11/05, 다른 해면 26/11/05
export function shortDate(d, today) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  if (today && today.slice(0, 4) === y) return `${m}/${day}`;
  return `${y.slice(2)}/${m}/${day}`;
}

// ISO 시각 → KST "11/05 06:48"
export function kstTime(iso) {
  if (!iso) return '';
  const t = new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString();
  return `${t.slice(5, 7)}/${t.slice(8, 10)} ${t.slice(11, 16)}`;
}
