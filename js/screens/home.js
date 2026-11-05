// 현황: 순자산, 증감, 시세·실사 상태, 실사 기간 요약, 추이 그래프, 자산군·계좌별 합계, 보유 목록
import * as L from '../ledger.js';
import { fmtWon, fmtWonChange, changeClass, fmtMoney } from '../format.js';
import { h, kstTime, shortDate, fmtBalance, accountName } from '../ui.js';
import { netChart } from '../chart.js';
import { openItemDialog } from './item-dialog.js';

let chartMode = 'daily';
const COUNT_CYCLE_DAYS = 60;
// 시세는 전날 종가면 충분하다. 하루 이틀 못 받으면 조용히 이전 가격을 쓰고, 이만큼 넘게 못 받으면 알린다.
const STALE_WARN_DAYS = 3;

// 마지막으로 시세(또는 환율)를 받은 뒤 며칠 지났는지. 갱신 실패가 아니면 null
function staleDays(r, today) {
  if (r.status !== 'stale') return null;
  const at = r.staleAt || (r.quote && r.quote.at);
  return at ? L.daysBetween(L.kstDate(new Date(at)), today) : STALE_WARN_DAYS;
}

export function renderHome(main, ctx) {
  const { ledger, prices, history } = ctx.store;
  const today = ctx.today;

  if (!ledger.items.length) {
    main.append(
      h(
        'div',
        { class: 'card' },
        h('h2', null, '처음 자료를 넣어 주세요'),
        h('p', null, '실사 화면의 "엑셀 표 붙여넣기"에 지금 자산 표를 붙여 넣으면 시작돼요.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.go('count') }, '실사 화면으로'),
      ),
    );
    return;
  }

  const rows = L.valuate(ledger, prices, { asOf: today });
  const sum = L.summarize(rows);
  const held = rows.filter((r) => r.balance !== 0);
  main.append(heroCard(ctx, sum, held, today));

  const dates = L.countDates(ledger);
  const ps = dates.length ? L.periodSummary(ledger, prices, dates[dates.length - 1]) : null;
  if (ps && ps.prevDate) main.append(periodCard(ps, today));

  main.append(chartCard(ctx, history, today));
  main.append(h('div', { class: 'grid2' }, classCard(sum), accountCard(ledger, sum)));
  main.append(holdingsCard(ctx, ledger, held, sum, today));
}

function heroCard(ctx, sum, held, today) {
  const { ledger, prices, history } = ctx.store;
  const cmp = L.comparisons(history, today);
  const delta = (label, base) => {
    if (!base) return h('div', null, h('span', null, label), h('span', { class: 'muted' }, '기록 없음'));
    const d = sum.net - base.net;
    return h(
      'div',
      { title: `${base.date} 기록 ${fmtWon(base.net)}` },
      h('span', null, `${label}(${shortDate(base.date, today)})`),
      h('b', { class: changeClass(d) }, fmtWonChange(d)),
    );
  };

  const badges = [];
  badges.push(h('span', { class: 'badge' }, prices.updatedAt ? `시세 ${kstTime(prices.updatedAt)} 기준` : '시세 아직 안 받음'));
  const n = (st) => held.filter((r) => r.status === st).length;
  const staleCount = held.filter((r) => (staleDays(r, today) ?? -1) >= STALE_WARN_DAYS).length;
  if (staleCount) badges.push(h('span', { class: 'badge warn' }, `시세 ${STALE_WARN_DAYS}일 넘게 못 받음 ${staleCount}개`));
  if (n('temp')) badges.push(h('span', { class: 'badge' }, `임시 단가 ${n('temp')}개`));
  if (n('none')) badges.push(h('span', { class: 'badge bad' }, `시세 없음 ${n('none')}개`));
  if (n('nofx')) badges.push(h('span', { class: 'badge bad' }, `환율 없음 ${n('nofx')}개`));
  const cs = L.countStatus(ledger, today).oldest;
  if (cs) {
    const late = cs.days >= COUNT_CYCLE_DAYS;
    const text = cs.date ? `마지막 실사 ${cs.days}일 전` : `실사 안 한 계좌 ${cs.days}일째`;
    badges.push(late ? h('a', { class: 'badge warn', href: '#/count' }, text + ' · 실사할 때예요') : h('span', { class: 'badge' }, text));
  }

  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'hero-label' }, '순자산'),
    h('div', { class: 'hero' }, fmtWon(sum.net)),
    h('div', { class: 'sub' }, `자산 ${fmtWon(sum.assets)}`, sum.debt ? ` · 부채 ${fmtWon(sum.debt)}` : ''),
    h('div', { class: 'deltas' }, delta('전일 대비', cmp.prevDay), delta('지난달 말 대비', cmp.prevMonthEnd)),
    h('div', { class: 'notes' }, badges),
  );
}

function periodCard(ps, today) {
  const per = ps.cashPerMonth;
  return h(
    'section',
    { class: 'card' },
    h('h2', null, `지난 실사 기간 (${shortDate(ps.prevDate, today)} → ${shortDate(ps.date, today)}, ${ps.days}일)`),
    h(
      'div',
      { class: 'spread' },
      h('span', null, '기록 안 한 현금 흐름(수입 − 지출)'),
      h('b', { class: changeClass(ps.cash) }, fmtWonChange(ps.cash), per != null ? h('span', { class: 'muted small' }, ` · 한 달에 약 ${fmtWonChange(per)}`) : null),
    ),
    h('div', { class: 'spread small' }, h('span', { class: 'muted' }, '그 밖의 차이(채권 평가, 기록 안 한 매매 등)'), h('span', { class: changeClass(ps.other) }, fmtWonChange(ps.other))),
    ps.added ? h('div', { class: 'spread small' }, h('span', { class: 'muted' }, '새로 넣은 항목(흐름에서 뺌)'), h('span', null, fmtWon(ps.added))) : null,
    h('p', { class: 'muted small' }, '현금·예수금이 기록한 것보다 얼마나 늘거나 줄었는지예요. 마이너스면 그만큼 생활비 등으로 더 쓴 거예요.'),
  );
}

function chartCard(ctx, history, today) {
  const card = h('section', { class: 'card' });
  const series = L.historySeries(history, { mode: chartMode, today, days: 90 });
  const btn = (mode, label) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': chartMode === mode ? 'true' : 'false',
        onclick: () => {
          chartMode = mode;
          ctx.render();
        },
      },
      label,
    );
  card.append(
    h('div', { class: 'spread' }, h('h2', null, '순자산 추이'), h('div', { class: 'seg' }, btn('daily', '최근 90일'), btn('monthly', '월별'))),
    netChart(series, { today, label: chartMode === 'daily' ? '최근 90일 순자산' : '월별 순자산' }),
  );
  return card;
}

function classCard(sum) {
  const card = h('section', { class: 'card' }, h('h2', null, '자산군별'));
  for (const cls of L.ASSET_CLASSES) {
    const v = sum.byClass[cls];
    if (!v) continue;
    const pct = sum.assets > 0 && v > 0 ? (v / sum.assets) * 100 : 0;
    card.append(
      h(
        'div',
        { class: 'share' },
        h('span', null, cls),
        h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${pct.toFixed(1)}%; display:block` })),
        h('span', { class: 'num right' }, fmtWon(v), h('span', { class: 'muted small' }, v > 0 ? ` ${pct.toFixed(0)}%` : '')),
      ),
    );
  }
  return card;
}

function accountCard(ledger, sum) {
  const card = h('section', { class: 'card' }, h('h2', null, '계좌별'));
  const list = Object.entries(sum.byAccount).sort((a, b) => b[1] - a[1]);
  card.append(
    h(
      'table',
      null,
      h('tbody', null, list.map(([id, v]) => h('tr', null, h('td', null, accountName(ledger, id)), h('td', { class: 'num' }, fmtWon(v))))),
    ),
  );
  return card;
}

function statusBadge(r, today) {
  if (r.status === 'stale') {
    const days = staleDays(r, today);
    if (days < STALE_WARN_DAYS) return null; // 전날 종가 정도면 충분하므로 표시하지 않음
    return h('span', { class: 'badge warn', title: r.quote && r.quote.error ? r.quote.error : '' }, `시세 ${days}일 전 것`);
  }
  if (r.status === 'temp') return h('span', { class: 'badge' }, '임시 단가');
  if (r.status === 'none') return h('span', { class: 'badge bad' }, '시세 없음');
  if (r.status === 'nofx') return h('span', { class: 'badge bad' }, '환율 없음');
  return null;
}

function holdingsCard(ctx, ledger, held, sum, today) {
  const card = h('section', { class: 'card' }, h('h2', null, '보유 목록'), h('p', { class: 'muted small' }, '항목을 누르면 이름·코드를 고치거나 값을 바로잡을 수 있어요.'));
  const byAcc = new Map();
  for (const r of held) {
    if (!byAcc.has(r.item.accountId)) byAcc.set(r.item.accountId, []);
    byAcc.get(r.item.accountId).push(r);
  }
  const accIds = [...byAcc.keys()].sort((a, b) => (sum.byAccount[b] || 0) - (sum.byAccount[a] || 0));
  const body = h('tbody');
  for (const id of accIds) {
    body.append(h('tr', { class: 'group' }, h('td', { colspan: 2 }, accountName(ledger, id)), h('td', { class: 'num' }, fmtWon(sum.byAccount[id] || 0))));
    const list = byAcc.get(id).sort((a, b) => b.value - a.value);
    for (const r of list) {
      const qname = r.quote && r.quote.name && r.quote.name !== r.item.name ? r.quote.name : null;
      const priceText = r.price != null && L.isQtyItem(r.item) ? `시세 ${fmtMoney(r.price, r.currency)}` : null;
      const subText = [priceText, qname].filter(Boolean).join(' · ');
      body.append(
        h(
          'tr',
          { class: 'click', tabindex: 0, onclick: () => openItemDialog(ctx, r.item), onkeydown: (e) => e.key === 'Enter' && openItemDialog(ctx, r.item) },
          h('td', null, r.item.name, ' ', statusBadge(r, today), subText ? h('span', { class: 'sub-name' }, subText) : null),
          h('td', { class: 'num' }, fmtBalance(r.item, r.balance)),
          h('td', { class: 'num' }, fmtWon(r.value)),
        ),
      );
    }
  }
  card.append(
    h(
      'table',
      null,
      h('thead', null, h('tr', null, h('th', null, '이름'), h('th', { class: 'num' }, '수량·금액'), h('th', { class: 'num' }, '평가액'))),
      body,
    ),
  );
  return card;
}
