// 순자산 추이 선 그래프(직접 그린 SVG, 외부 라이브러리 없음).
// 선 2px, 끝점 r4 + 바탕색 테두리, 면은 10% 옅게, 눈금선은 1px 실선. 마우스·키보드로 날짜별 값 보기.
import { h, s, clear, shortDate } from './ui.js';
import { fmtWon } from './format.js';

const DAY = 86400000;
const t = (d) => Date.parse(d + 'T00:00:00Z');

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

// 축 눈금: 10.8억 / 1,250만 / 9,000원
function axisLabel(v, step) {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e8 || step >= 1e8) {
    const dec = step >= 1e8 ? 0 : step >= 1e7 ? 1 : step >= 1e6 ? 2 : 3;
    return sign + (a / 1e8).toFixed(dec) + '억';
  }
  if (a >= 1e4 || step >= 1e4) return sign + Math.round(a / 1e4).toLocaleString('ko-KR') + '만';
  return sign + Math.round(a).toLocaleString('ko-KR') + '원';
}

export function netChart(points, { today, label = '순자산' } = {}) {
  const box = h('div', { class: 'chart' });
  if (!points.length) {
    box.append(h('p', { class: 'muted' }, '아직 쌓인 기록이 없어요. 자동 시세가 처음 돌면(장부를 저장하거나 매일 아침) 하루에 한 점씩 쌓여요.'));
    return box;
  }
  const tip = h('div', { class: 'tip', hidden: true });
  const holder = h('div');
  box.append(holder, tip, table(points, today));

  let width = 0;
  const draw = () => {
    const w = Math.max(280, Math.round(box.clientWidth || 640));
    if (w === width) return;
    width = w;
    clear(holder).append(svgChart(points, w, tip, today, label));
  };
  requestAnimationFrame(draw);
  if (typeof ResizeObserver === 'function') new ResizeObserver(draw).observe(box);
  return box;
}

function svgChart(points, W, tip, today, label) {
  const H = W < 480 ? 190 : 230;
  const m = { l: 58, r: 16, t: 26, b: 26 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const nets = points.map((p) => p.net);
  let lo = Math.min(...nets);
  let hi = Math.max(...nets);
  if (lo === hi) {
    const pad = Math.max(Math.abs(hi) * 0.01, 10000);
    lo -= pad;
    hi += pad;
  }
  const step = niceStep((hi - lo) / 3);
  const y0 = Math.floor(lo / step) * step;
  const y1 = Math.ceil(hi / step) * step;
  const t0 = t(points[0].date);
  const t1 = t(points[points.length - 1].date);
  const x = (d) => m.l + (t1 === t0 ? iw / 2 : ((t(d) - t0) / (t1 - t0)) * iw);
  const y = (v) => m.t + ih - ((v - y0) / (y1 - y0)) * ih;

  const svg = s('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: 'img',
    tabindex: 0,
    'aria-label': `${label} 그래프. ${points[0].date}부터 ${points[points.length - 1].date}까지 ${points.length}개 기록. 마지막 값 ${fmtWon(nets[nets.length - 1])}. 왼쪽·오른쪽 화살표로 날짜별 값을 볼 수 있어요.`,
  });

  // 눈금선과 축 글자
  for (let v = y0; v <= y1 + step / 2; v += step) {
    const yy = y(v);
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.append(s('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis-text' }, axisLabel(v, step)));
  }
  const xLabels = [points[0]];
  if (points.length > 2) xLabels.push(points[Math.floor((points.length - 1) / 2)]);
  if (points.length > 1) xLabels.push(points[points.length - 1]);
  xLabels.forEach((p, i) => {
    const anchor = i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle';
    svg.append(s('text', { x: x(p.date), y: H - 6, 'text-anchor': points.length === 1 ? 'middle' : anchor, class: 'axis-text' }, shortDate(p.date, today)));
  });

  // 면과 선
  const pts = points.map((p) => [x(p.date), y(p.net)]);
  if (pts.length > 1) {
    const line = pts.map(([a, b], i) => (i ? 'L' : 'M') + a.toFixed(1) + ' ' + b.toFixed(1)).join(' ');
    const base = (m.t + ih).toFixed(1);
    svg.append(s('path', { d: `${line} L${pts.at(-1)[0].toFixed(1)} ${base} L${pts[0][0].toFixed(1)} ${base} Z`, fill: 'var(--series)', 'fill-opacity': 0.1 }));
    svg.append(s('path', { d: line, fill: 'none', stroke: 'var(--series)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  // 끝점과 끝값
  const [ex, ey] = pts.at(-1);
  svg.append(s('circle', { cx: ex, cy: ey, r: 4, fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  svg.append(s('text', { x: Math.min(ex, W - m.r), y: Math.max(ey - 10, 12), 'text-anchor': pts.length > 1 ? 'end' : 'middle', class: 'end-text' }, fmtWon(nets.at(-1))));

  // 십자선과 말풍선
  const cross = s('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--text-3)', 'stroke-width': 1, visibility: 'hidden' });
  const dot = s('circle', { r: 4, fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, dot);
  let idx = -1;
  const show = (i) => {
    idx = Math.max(0, Math.min(points.length - 1, i));
    const [px, py] = pts[idx];
    for (const el of [cross, dot]) el.setAttribute('visibility', 'visible');
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', py);
    clear(tip).append(h('b', null, fmtWon(points[idx].net)), points[idx].date);
    tip.hidden = false;
    const scale = (svg.getBoundingClientRect().width || W) / W;
    const left = px * scale;
    tip.style.top = Math.max(0, py * scale - 64) + 'px';
    tip.style.left = left + 'px';
    tip.style.transform = left > (W * scale) / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)';
  };
  const hide = () => {
    for (const el of [cross, dot]) el.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / (r.width || W)) * W;
    let best = 0;
    pts.forEach(([a], i) => {
      if (Math.abs(a - px) < Math.abs(pts[best][0] - px)) best = i;
    });
    return best;
  };
  svg.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      show(idx < 0 ? points.length - 1 : idx + (e.key === 'ArrowLeft' ? -1 : 1));
    } else if (e.key === 'Escape') hide();
  });
  return svg;
}

function table(points, today) {
  const rows = [...points].reverse().slice(0, 120);
  return h(
    'details',
    { class: 'small' },
    h('summary', null, '숫자로 보기'),
    h(
      'table',
      null,
      h('thead', null, h('tr', null, h('th', null, '날짜'), h('th', { class: 'num' }, '순자산'))),
      h('tbody', null, rows.map((p) => h('tr', null, h('td', null, shortDate(p.date, today)), h('td', { class: 'num' }, fmtWon(p.net))))),
    ),
  );
}

export const _test = { niceStep, axisLabel };
export { DAY };
