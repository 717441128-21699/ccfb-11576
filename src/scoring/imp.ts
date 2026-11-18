/**
 * IMP（国际比赛分）换算表，WBF 标准。
 * 索引为分差的绝对值，值为对应 IMP；超过 4000 分按每 1000 分 1 IMP 外推。
 */
const IMP_TABLE: Array<[number, number]> = [
  [20, 0], [40, 1], [80, 2], [120, 3], [160, 4], [210, 5], [260, 6],
  [310, 7], [360, 8], [420, 9], [490, 10], [590, 11], [740, 12], [890, 13],
  [1090, 14], [1290, 15], [1490, 16], [1740, 17], [1990, 18], [2240, 19],
  [2490, 20], [2990, 21], [3490, 22], [3990, 23],
];

export function diffToImp(diff: number): number {
  const d = Math.abs(diff);
  for (const [threshold, imp] of IMP_TABLE) {
    if (d <= threshold) return imp;
  }
  // 4000 分以上：每满 1000 分增加 1 IMP
  return 24 + Math.floor((d - 4000) / 1000);
}

/**
 * 两队分差转带符号 IMP（保留方向）。
 */
export function signedImp(diff: number): number {
  const imp = diffToImp(diff);
  return diff < 0 ? -imp : imp;
}
