// 설정: 데이터 저장소와 토큰. 저장하면 앱이 저장소를 알아서 준비한다(없는 파일 만들기, 자동 시세 설정).
import { h, kstTime } from '../ui.js';
import { clearToken } from '../store.js';
import { parseRepo } from '../github.js';

export function renderSettings(main, ctx) {
  const repo = h('input', { type: 'text', value: ctx.settings.repo || '', placeholder: '내아이디/asset-data', autocomplete: 'off', spellcheck: 'false' });
  const token = h('input', {
    type: 'password',
    value: '',
    placeholder: ctx.settings.token ? '저장된 토큰 사용 중 (바꿀 때만 넣으세요)' : 'github_pat_로 시작하는 토큰',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const steps = h('div', { class: 'small muted' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, '저장하고 시작');
  const go = async () => {
    const settings = { repo: repo.value.trim(), token: token.value.trim() || ctx.settings.token || '' };
    if (!parseRepo(settings.repo)) {
      ctx.toast('저장소는 "아이디/저장소이름" 모양으로 넣어 주세요.', 'bad');
      return;
    }
    if (!settings.token) {
      ctx.toast('토큰을 넣어 주세요.', 'bad');
      return;
    }
    if (!/^[\x21-\x7E]+$/.test(settings.token)) {
      ctx.toast('토큰에 다른 글자(한글·보이지 않는 글자 등)가 섞였어요. GitHub에서 토큰만 다시 복사해 붙여 넣어 주세요.', 'bad');
      return;
    }
    btn.disabled = true;
    steps.replaceChildren();
    try {
      const store = await ctx.setup(settings, (s) => steps.append(h('div', null, '· ' + s)));
      ctx.toast(store.workflow === 'failed' ? '연결했어요. 다만 자동 시세 설정은 만들지 못했어요(토큰의 Workflows 권한 확인).' : '연결했어요.', store.workflow === 'failed' ? 'bad' : '');
      ctx.go(store.ledger.items.length ? 'home' : 'count');
    } catch (e) {
      ctx.toast(ctx.explain(e), 'bad');
    } finally {
      btn.disabled = false;
    }
  };

  const owner = (parseRepo(ctx.settings.repo) || {}).owner;
  const tokenUrl =
    'https://github.com/settings/personal-access-tokens/new?' +
    new URLSearchParams({ name: 'asset-app', description: '내 자산 현황 앱(데이터 저장소 하나)', contents: 'write', workflows: 'write', ...(owner ? { target_name: owner } : {}) }).toString();

  main.append(
    h(
      'section',
      { class: 'card' },
      h('h2', null, '설정'),
      h(
        'form',
        { onsubmit: (e) => (e.preventDefault(), go()) },
        h('label', null, '내 데이터 저장소 (비공개)'),
        repo,
        h('label', null, '토큰'),
        token,
        h('p', { class: 'muted small' }, '토큰은 이 브라우저에만 저장돼요. 다른 PC나 브라우저에서는 다시 넣어야 해요.'),
        h('div', { class: 'actions' }, btn),
        steps,
      ),
    ),
  );

  if (ctx.store && ctx.state === 'ready') {
    const s = ctx.store;
    const wf = { ok: '최신', updated: '방금 맞춤', failed: '만들지 못함(토큰의 Workflows 권한 확인)', unknown: '확인 전' }[s.workflow] || s.workflow;
    main.append(
      h(
        'section',
        { class: 'card' },
        h('h2', null, '지금 상태'),
        h(
          'table',
          { class: 'small' },
          h(
            'tbody',
            null,
            h('tr', null, h('td', null, '데이터 저장소'), h('td', null, h('a', { href: `https://github.com/${s.repoName}`, target: '_blank', rel: 'noopener' }, s.repoName))),
            h('tr', null, h('td', null, '장부'), h('td', null, `계좌 ${s.ledger.accounts.length}개 · 항목 ${s.ledger.items.length}개 · 기록 ${s.ledger.entries.length}건`)),
            h('tr', null, h('td', null, '마지막 시세 갱신'), h('td', null, s.prices.updatedAt ? kstTime(s.prices.updatedAt) : '아직 없음')),
            h('tr', null, h('td', null, '자동 시세 설정'), h('td', null, wf)),
          ),
        ),
        h(
          'p',
          { class: 'small' },
          '시세를 지금 바로 받으려면: ',
          h('a', { href: `https://github.com/${s.repoName}/actions`, target: '_blank', rel: 'noopener' }, 'GitHub Actions 화면'),
          ' → 왼쪽 "시세 갱신" → 오른쪽 "Run workflow" → 1~2분 뒤 앱의 ↻(새로 불러오기).',
        ),
      ),
    );
  }

  main.append(
    h(
      'section',
      { class: 'card' },
      h('h2', null, '처음 설정 순서'),
      h(
        'ol',
        null,
        h('li', null, 'GitHub에서 비공개 저장소를 만들어요: ', h('a', { href: 'https://github.com/new?name=asset-data&visibility=private', target: '_blank', rel: 'noopener' }, '새 저장소 만들기'), ' → 이름 asset-data, Private 선택 → Create repository.'),
        h(
          'li',
          null,
          '토큰을 만들어요: ',
          h('a', { href: tokenUrl, target: '_blank', rel: 'noopener' }, '토큰 만들기 화면'),
          ' → Expiration은 No expiration, Repository access는 Only select repositories에서 asset-data 하나, Permissions에서 Contents와 Workflows를 Read and write → Generate token → 나온 토큰 복사.',
        ),
        h('li', null, '위 칸에 "내아이디/asset-data"와 토큰을 넣고 저장하고 시작.'),
        h('li', null, '실사 화면의 엑셀 붙여넣기로 처음 자료를 넣어요. 1~2분 뒤 ↻를 누르면 시세가 들어와요.'),
      ),
      h('p', { class: 'muted small' }, '이 계정으로 다른 GitHub Pages 사이트를 만들 때는 외부 스크립트를 넣지 마세요(같은 주소 아래라 이 토큰을 읽을 수 있어요).'),
      ctx.settings.token
        ? h(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              onclick: () => {
                clearToken();
                ctx.settings = { ...ctx.settings, token: '' };
                ctx.store = null;
                ctx.state = 'idle';
                ctx.toast('이 브라우저에서 토큰을 지웠어요.');
                ctx.render();
              },
            },
            '이 브라우저에서 토큰 지우기',
          )
        : null,
    ),
  );
}
