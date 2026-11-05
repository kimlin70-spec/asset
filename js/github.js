// GitHub API로 내 비공개 데이터 저장소의 파일을 읽고 쓴다.
// - 요청은 브라우저 캐시를 쓰지 않는다(cache: 'no-store'): GitHub 응답은 60초 캐시될 수 있어 옛 내용이 올 수 있다.
// - 내용은 UTF-8을 base64로 바꿔 주고받는다(한글 이름이 깨지지 않게).
// - 1MB가 넘는 파일은 git blob API로 읽는다.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// "아이디/저장소", "https://github.com/아이디/저장소" 모두 받는다.
export function parseRepo(input) {
  const t = String(input || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(t);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// 사람이 읽을 오류 문장
export function explain(err, during = '') {
  if (!(err instanceof GitHubError)) return err && err.message ? err.message : String(err);
  during = during || err.during || '';
  const s = err.status;
  if (s === 0) return '인터넷 연결을 확인해 주세요.';
  if (s === 401) return '토큰이 만료됐거나 잘못됐어요. 설정에서 새 토큰을 넣어 주세요.';
  if (s === 403 && /rate limit/i.test(err.detail)) return 'GitHub 요청 한도에 걸렸어요. 잠시 뒤 다시 해 주세요.';
  if (s === 403 || (s === 404 && during === 'write'))
    return '토큰 권한이 모자라요. 토큰의 Contents와 Workflows를 Read and write로 해 주세요.';
  if (s === 404 && during === 'repo')
    return '저장소를 찾을 수 없어요. 이름이 맞는지, 토큰을 만들 때 이 저장소를 골랐는지 확인해 주세요.';
  if (s === 404) return '파일을 찾을 수 없어요.';
  if (s === 409) return '다른 곳에서 먼저 저장했어요. 다시 시도해 주세요.';
  if (s >= 500) return 'GitHub에 잠시 문제가 있어요. 잠시 뒤 다시 해 주세요.';
  return `GitHub 오류(${s}): ${err.detail || err.message}`;
}

export function createClient({ owner, repo, token, fetchImpl = (...a) => fetch(...a) }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(API + path, {
        method,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError(0, '인터넷 연결을 확인해 주세요.');
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch {
      /* 본문 없음 */
    }
    throw new GitHubError(res.status, detail || `HTTP ${res.status}`, detail);
  }

  return {
    owner,
    repo,
    // 저장소와 토큰 확인
    async checkRepo() {
      return call('GET', base);
    },
    // 파일 읽기. 없으면 null. 빈 저장소("This repository is empty")도 없음으로 본다.
    async getFile(path) {
      let meta;
      try {
        meta = await call('GET', `${base}/contents/${encodePath(path)}`);
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404) return null;
        throw e;
      }
      if (Array.isArray(meta) || meta.type !== 'file') throw new GitHubError(422, `${path}가 파일이 아니에요.`);
      let b64 = meta.content;
      if ((!b64 || meta.encoding === 'none') && meta.size > 0) {
        const blob = await call('GET', `${base}/git/blobs/${meta.sha}`);
        b64 = blob.content;
      }
      return { sha: meta.sha, text: b64 ? base64ToUtf8(b64) : '' };
    },
    // 파일 쓰기. sha가 없으면 새로 만들기(이미 있으면 GitHub가 422로 거절 → 덮어쓰지 않음).
    async putFile(path, text, sha, message) {
      const body = { message, content: utf8ToBase64(text) };
      if (sha) body.sha = sha;
      const res = await call('PUT', `${base}/contents/${encodePath(path)}`, body);
      return res.content.sha;
    },
  };
}
