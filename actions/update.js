// 데이터 저장소의 GitHub Actions가 실행한다: node app/actions/update.js data
// 시세를 받아 prices.json에 쓰고, 오늘(KST) 합계를 history.json에 쓴다.
// 시세가 일부·전부 실패해도 정상 종료한다(실패는 prices.json과 앱 화면으로 알린다).
// 장부가 깨진 경우처럼 진짜 문제일 때만 실패로 끝낸다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as L from '../js/ledger.js';
import { updatePrices } from './sources.js';

const dir = process.argv[2] || '.';

function read(file, fallback) {
  const p = join(dir, file);
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function write(file, obj) {
  writeFileSync(join(dir, file), JSON.stringify(obj, null, 1) + '\n');
}

async function main() {
  const ledger = read('ledger.json', null);
  if (!ledger) {
    console.log('장부(ledger.json)가 아직 없어요. 할 일 없음.');
    return 0;
  }
  const problems = L.validateLedger(ledger);
  if (problems.length) {
    console.error('장부 검사 실패:', problems.slice(0, 5).join(' | '));
    return 1;
  }
  const prices = read('prices.json', { version: 1, updatedAt: null, quotes: {} });
  const history = read('history.json', L.emptyHistory());
  const mode = process.env.GITHUB_EVENT_NAME === 'push' ? 'missing' : 'all';
  const now = new Date();

  const res = await updatePrices({ ledger, prices, mode, now });
  write('prices.json', res.prices);

  console.log(`모드 ${mode}: 시세 성공 ${res.ok.length}개, 실패 ${res.failed.length}개`);
  for (const k of res.failed) console.log(`  실패 ${k}: ${res.prices.quotes[k].error}`);

  // 장부에 아직 아무것도 없으면 합계를 남기지 않는다(0원 기록이 추이·증감을 망치지 않게)
  if (!ledger.entries.length) {
    write('history.json', history);
    console.log('장부가 비어 있어 오늘 합계는 남기지 않아요.');
    return 0;
  }
  const today = L.kstDate(now);
  const entry = L.historyEntry(ledger, res.prices, today);
  write('history.json', L.putHistory(history, today, entry));
  console.log(`${today} 순자산 ${entry.net.toLocaleString('ko-KR')}원`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('예상하지 못한 오류:', e && e.stack ? e.stack : e);
    process.exit(1);
  },
);
