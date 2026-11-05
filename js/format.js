// 화면 표시용 숫자 형식. DOM 없음(테스트 가능).

function groupDigits(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 1234567.891 -> "1,234,567.89" (decimals 자리까지, keepZeros가 아니면 끝의 0은 지움)
export function fmtNum(x, decimals = 0, keepZeros = false) {
  if (!Number.isFinite(x)) return '-';
  const fixed = Math.abs(x).toFixed(decimals);
  let [int, frac = ''] = fixed.split('.');
  if (!keepZeros) frac = frac.replace(/0+$/, '');
  const zero = /^0*$/.test(int + frac);
  const sign = x < 0 && !zero ? '−' : '';
  return sign + groupDigits(int) + (frac ? '.' + frac : '');
}

// 원화를 억·만 단위로: 523456789 -> "5억 2,346만원", 12345 -> "1만원", 9999 -> "9,999원"
export function fmtWon(n) {
  if (!Number.isFinite(n)) return '-';
  const a = Math.abs(Math.round(n));
  const sign = n < 0 && a !== 0 ? '−' : '';
  if (a < 10000) return sign + groupDigits(String(a)) + '원';
  const man = Math.round(a / 10000);
  const eok = Math.floor(man / 10000);
  const rest = man % 10000;
  const parts = [];
  if (eok) parts.push(groupDigits(String(eok)) + '억');
  if (rest) parts.push(groupDigits(String(rest)) + '만');
  return sign + parts.join(' ') + '원';
}

// 증감: "+1,234만원" / "−567만원" / "0원"
export function fmtWonChange(n) {
  if (!Number.isFinite(n)) return '-';
  const s = fmtWon(n);
  return n > 0 && Math.round(n) !== 0 ? '+' + s : s;
}

// 원 단위 전체: 1234567 -> "1,234,567원"
export function fmtWonFull(n) {
  if (!Number.isFinite(n)) return '-';
  return fmtNum(Math.round(n), 0) + '원';
}

// 통화 금액: KRW -> "1,234,567원", USD -> "$1,234.56", 그 밖 -> "1,234.56 JPY"
export function fmtMoney(x, currency = 'KRW') {
  if (!Number.isFinite(x)) return '-';
  if (currency === 'KRW') return fmtWonFull(x);
  if (currency === 'USD') {
    const s = fmtNum(Math.abs(x), 2, true);
    return (x < 0 && s !== '0.00' ? '−$' : '$') + s;
  }
  const d = currency === 'JPY' ? 0 : 2;
  return fmtNum(x, d, true) + ' ' + currency;
}

// 증가 빨강, 감소 파랑
export function changeClass(n) {
  if (!Number.isFinite(n) || Math.round(n) === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}
