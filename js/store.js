// 데이터 저장소와 주고받는 일: 설정(이 브라우저에만), 불러오기, 준비(파일·자동 시세 설정), 저장(충돌 시 다시 얹기).
import * as L from './ledger.js';
import { createClient, parseRepo, GitHubError } from './github.js';

// 같은 계정의 다른 GitHub Pages 사이트와 저장 공간을 나눠 쓰므로 키에 접두어를 붙인다.
const KEY_REPO = 'asset.repo';
const KEY_TOKEN = 'asset.token';

export const FILES = { ledger: 'ledger.json', prices: 'prices.json', history: 'history.json' };
export const WORKFLOW_PATH = '.github/workflows/asset-prices.yml';

export class StoreError extends Error {
  constructor(message, kind = '') {
    super(message);
    this.kind = kind;
  }
}

export function loadSettings() {
  try {
    return { repo: localStorage.getItem(KEY_REPO) || '', token: localStorage.getItem(KEY_TOKEN) || '' };
  } catch {
    return { repo: '', token: '' };
  }
}

export function saveSettings({ repo, token }) {
  try {
    localStorage.setItem(KEY_REPO, repo);
    localStorage.setItem(KEY_TOKEN, token);
    return true;
  } catch {
    return false;
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(KEY_TOKEN);
  } catch {
    /* 무시 */
  }
}

const emptyPrices = () => ({ version: 1, updatedAt: null, quotes: {} });

function parseJSON(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError(`${what} 파일이 깨져 있어요. 데이터 저장소의 기록(History)에서 이전 버전을 확인해 주세요.`, 'broken');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Store {
  constructor(settings, { fetchImpl } = {}) {
    const parsed = parseRepo(settings.repo);
    if (!parsed) throw new StoreError('저장소는 "아이디/저장소이름" 모양으로 넣어 주세요. 예: kimlin70-spec/asset-data', 'settings');
    if (!settings.token) throw new StoreError('토큰을 넣어 주세요.', 'settings');
    this.client = createClient({ ...parsed, token: settings.token.trim(), fetchImpl });
    this.repoName = `${parsed.owner}/${parsed.repo}`;
    this.ledger = null;
    this.ledgerSha = null;
    this.prices = emptyPrices();
    this.history = L.emptyHistory();
    this.workflow = 'unknown'; // ok | updated | failed | unknown
  }

  // 저장소 확인 → 없는 데이터 파일 만들기(있으면 절대 덮어쓰지 않음) → 자동 시세 설정 맞추기
  async prepare(workflowText, onStep = () => {}) {
    onStep('저장소 확인');
    let info;
    try {
      info = await this.client.checkRepo();
    } catch (e) {
      if (e instanceof GitHubError) e.during = 'repo';
      throw e;
    }
    // 개인 자료이므로 공개 저장소에는 절대 쓰지 않는다
    if (!info || info.private !== true) {
      throw new StoreError(
        `${this.repoName}은(는) 공개(Public) 저장소예요. 내 자료는 비공개 저장소에만 둘 수 있어요. 저장소 이름을 확인하거나, GitHub에서 그 저장소를 Private으로 바꾼 뒤 다시 눌러 주세요.`,
        'public',
      );
    }
    const initial = {
      [FILES.ledger]: () => L.emptyLedger(),
      [FILES.prices]: () => emptyPrices(),
      [FILES.history]: () => L.emptyHistory(),
    };
    for (const [path, make] of Object.entries(initial)) {
      onStep(`${path} 확인`);
      const f = await this.client.getFile(path);
      if (f) continue;
      try {
        await this.client.putFile(path, JSON.stringify(make(), null, 1) + '\n', undefined, `처음 파일 만들기: ${path}`);
      } catch (e) {
        // 그 사이 다른 곳에서 만들었으면(422) 그대로 둔다
        if (!(e instanceof GitHubError && e.status === 422)) {
          if (e instanceof GitHubError) e.during = 'write';
          throw e;
        }
      }
    }
    if (workflowText) await this.syncWorkflow(workflowText, onStep);
  }

  // 자동 시세 설정(워크플로) 파일은 개인 데이터가 없으므로, 없거나 앱에 든 것과 다르면 새로 쓴다.
  async syncWorkflow(workflowText, onStep = () => {}) {
    onStep('자동 시세 설정 확인');
    try {
      const f = await this.client.getFile(WORKFLOW_PATH);
      if (f && f.text === workflowText) {
        this.workflow = 'ok';
        return;
      }
      await this.client.putFile(WORKFLOW_PATH, workflowText, f ? f.sha : undefined, '자동 시세 설정 맞추기');
      this.workflow = 'updated';
    } catch (e) {
      this.workflow = 'failed';
      this.workflowError = e;
    }
  }

  async load() {
    const lf = await this.client.getFile(FILES.ledger);
    if (!lf) throw new StoreError('장부 파일이 아직 없어요. 설정에서 "저장하고 시작"을 눌러 주세요.', 'missing');
    const ledger = parseJSON(lf.text, '장부(ledger.json)');
    const problems = L.validateLedger(ledger);
    if (problems.length) throw new StoreError('장부에 문제가 있어요: ' + problems[0], 'broken');
    this.ledger = ledger;
    this.ledgerSha = lf.sha;
    const pf = await this.client.getFile(FILES.prices);
    this.prices = pf ? parseJSON(pf.text, '시세(prices.json)') : emptyPrices();
    if (!this.prices.quotes) this.prices.quotes = {};
    const hf = await this.client.getFile(FILES.history);
    this.history = hf ? parseJSON(hf.text, '합계 기록(history.json)') : L.emptyHistory();
    if (!this.history.days) this.history.days = {};
  }

  // 장부 바꾸기. op(장부) → 새 장부. 다른 곳에서 먼저 저장했으면(409) 최신 장부를 다시 읽고 op를 다시 적용한다.
  // op가 장부를 그대로 돌려주면(같은 id가 이미 있음 = 앞에서 누른 저장이 이미 들어감) 저장하지 않고 'already'를 돌려준다.
  async mutate(op, message) {
    for (let attempt = 0; ; attempt++) {
      const next = op(this.ledger); // LedgerError는 그대로 위로
      if (next === this.ledger) return 'already';
      const problems = L.validateLedger(next);
      if (problems.length) throw new StoreError('저장 전 검사에서 문제가 나와 저장하지 않았어요: ' + problems[0], 'invalid');
      try {
        const sha = await this.client.putFile(FILES.ledger, JSON.stringify(next, null, 1) + '\n', this.ledgerSha, message);
        this.ledger = next;
        this.ledgerSha = sha;
        return next;
      } catch (e) {
        const conflict = e instanceof GitHubError && (e.status === 409 || (e.status === 422 && /sha/i.test(e.detail)));
        if (!conflict || attempt >= 3) {
          if (e instanceof GitHubError && e.status !== 409) e.during = 'write';
          throw e;
        }
        await sleep(1000 * 2 ** attempt);
        const lf = await this.client.getFile(FILES.ledger);
        if (!lf) throw new StoreError('장부 파일이 사라졌어요. 설정에서 "저장하고 시작"을 다시 눌러 주세요.', 'missing');
        this.ledger = parseJSON(lf.text, '장부(ledger.json)');
        this.ledgerSha = lf.sha;
      }
    }
  }
}

// 이 앱이 올라가 있는 저장소(자동 시세가 받아서 돌릴 코드). Pages 주소에서 알아낸다.
export function appRepoFromLocation(loc = globalThis.location) {
  try {
    const host = loc.hostname || '';
    const seg = (loc.pathname || '').split('/').filter(Boolean)[0];
    if (host.endsWith('.github.io') && seg) return `${host.split('.')[0]}/${seg}`;
  } catch {
    /* 무시 */
  }
  return 'kimlin70-spec/asset';
}

export function fillWorkflowTemplate(template, appRepo) {
  return template.replaceAll('__APP_REPO__', appRepo);
}
