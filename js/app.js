// 앱 시작, 화면 전환, 저장 도우미
import * as L from './ledger.js';
import { Store, StoreError, loadSettings, saveSettings, appRepoFromLocation, fillWorkflowTemplate } from './store.js';
import { explain, GitHubError } from './github.js';
import { h, clear, toast } from './ui.js';
import { renderHome } from './screens/home.js';
import { renderInput } from './screens/input.js';
import { renderCount } from './screens/count.js';
import { renderRecords } from './screens/records.js';
import { renderSettings } from './screens/settings.js';

const SCREENS = { home: renderHome, input: renderInput, count: renderCount, records: renderRecords, settings: renderSettings };
const main = document.getElementById('app');

export function explainAny(e) {
  if (e instanceof GitHubError) return explain(e);
  if (e instanceof L.LedgerError || e instanceof StoreError) return e.message;
  return '문제가 생겼어요: ' + (e && e.message ? e.message : String(e));
}

const ctx = {
  store: null,
  settings: loadSettings(),
  state: 'idle', // idle | loading | ready | error
  error: null,
  get today() {
    return L.kstDate();
  },
  go(route) {
    if (location.hash === '#/' + route) render();
    else location.hash = '#/' + route;
  },
  render,
  toast,
  explain: explainAny,

  async workflowText() {
    const res = await fetch('./setup/asset-prices.yml', { cache: 'no-store' });
    if (!res.ok) throw new Error('자동 시세 설정 파일을 앱에서 찾지 못했어요.');
    return fillWorkflowTemplate(await res.text(), appRepoFromLocation());
  },

  // 설정 화면의 "저장하고 시작": 확인 → 없는 파일 만들기 → 자동 시세 설정 → 불러오기
  async setup(settings, onStep) {
    const store = new Store(settings);
    let wf = null;
    try {
      wf = await ctx.workflowText();
    } catch {
      /* 화면 파일을 못 받으면 자동 시세 설정만 건너뛴다 */
    }
    await store.prepare(wf, onStep);
    onStep('장부 불러오기');
    await store.load();
    saveSettings(settings);
    ctx.settings = settings;
    ctx.store = store;
    ctx.state = 'ready';
    ctx.error = null;
    return store;
  },

  async connect() {
    ctx.state = 'loading';
    render();
    try {
      const store = new Store(ctx.settings);
      try {
        await store.load();
      } catch (e) {
        if (!(e instanceof StoreError && e.kind === 'missing')) throw e;
        await store.prepare(await ctx.workflowText().catch(() => null));
        await store.load();
      }
      ctx.store = store;
      ctx.state = 'ready';
      ctx.error = null;
      syncWorkflowQuietly(store);
    } catch (e) {
      ctx.state = 'error';
      ctx.error = e;
    }
    render();
  },

  async reload() {
    if (!ctx.store) return ctx.connect();
    try {
      await ctx.store.load();
      toast('새로 불러왔어요.');
    } catch (e) {
      toast(explainAny(e), 'bad');
    }
    render();
  },

  // 장부 저장. 성공하면 true
  async save(op, message, okMessage) {
    try {
      await ctx.store.mutate(op, message);
      if (okMessage) toast(okMessage);
      return true;
    } catch (e) {
      toast(explainAny(e), 'bad');
      return false;
    }
  },
};

function syncWorkflowQuietly(store) {
  ctx
    .workflowText()
    .then((text) => store.syncWorkflow(text))
    .then(() => {
      if (store.workflow === 'updated') toast('자동 시세 설정을 최신으로 맞췄어요.');
      else if (store.workflow === 'failed') toast('자동 시세 설정을 맞추지 못했어요: ' + explain(store.workflowError, 'write'), 'bad');
    })
    .catch(() => {});
}

function currentRoute() {
  const r = location.hash.replace(/^#\/?/, '').split('?')[0];
  return SCREENS[r] ? r : 'home';
}

function render() {
  const route = currentRoute();
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  clear(main);
  const configured = ctx.settings.repo && ctx.settings.token;
  if (route !== 'settings') {
    if (!configured) {
      main.append(
        h(
          'div',
          { class: 'card' },
          h('h2', null, '처음 오셨네요'),
          h('p', null, '설정에서 내 데이터 저장소와 토큰을 넣으면 시작할 수 있어요.'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.go('settings') }, '설정으로'),
        ),
      );
      return;
    }
    if (ctx.state === 'loading' || ctx.state === 'idle') {
      main.append(h('p', { class: 'muted center pad' }, '불러오는 중…'));
      return;
    }
    if (ctx.state === 'error') {
      main.append(
        h(
          'div',
          { class: 'card' },
          h('h2', null, '불러오지 못했어요'),
          h('p', { class: 'notice bad' }, explainAny(ctx.error)),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.connect() }, '다시 시도'),
            h('button', { class: 'btn', type: 'button', onclick: () => ctx.go('settings') }, '설정 보기'),
          ),
        ),
      );
      return;
    }
  }
  try {
    SCREENS[route](main, ctx);
  } catch (e) {
    console.error(e);
    clear(main).append(h('div', { class: 'card' }, h('p', { class: 'notice bad' }, '화면을 그리다 문제가 생겼어요: ' + (e && e.message))));
  }
}

window.addEventListener('hashchange', () => {
  render();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
document.getElementById('reload').addEventListener('click', () => ctx.reload());

if (ctx.settings.repo && ctx.settings.token) ctx.connect();
else render();
