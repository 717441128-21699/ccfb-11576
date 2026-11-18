import { type Contract, type Vulnerability, scoreContract, toNsSigned } from './contract.js';
import { diffToImp, signedImp } from './imp.js';

/**
 * 复式比赛的成绩汇总与排名。
 *
 * 复式桥牌常见两种计分：
 *  - 比赛分（Matchpoint, MP）：同一副牌在所有桌的成绩两两比较，
 *    赢一对得 1 分、平得 0.5 分，按总分排名；
 *  - 平均 IMP（Butler IMP）：每对每副牌与其余桌该副的平均分（或中位数）
 *    比较，分差转 IMP 后累计。
 *  - 队际 IMP：两桌同一副牌的 NS 视角分差直接转 IMP。
 */

/** 某桌某副牌的一条成绩 */
export interface BoardResult {
  boardId: number;
  /** 桌号 */
  tableId: number;
  /** 坐在 NS 方向的牌号 */
  nsPairId: number;
  /** 坐在 EW 方向的牌号 */
  ewPairId: number;
  contract: Contract;
  /** 庄家方实际墩数 */
  tricks: number;
  vul: Vulnerability;
}

/** 计算一条成绩的 NS 视角带符号分 */
export function resultNsScore(r: BoardResult): number {
  const sr = scoreContract(r.contract, { tricks: r.tricks }, r.vul);
  return toNsSigned(sr);
}

/**
 * 比赛分（Matchpoint）汇总。
 * 输入同一副牌在各桌的成绩，返回每个牌号在该副牌拿到的比赛分。
 * 比较以“牌号在该桌所坐方向”的得分为准。
 */
export function matchpointsForBoard(
  results: BoardResult[],
): Map<number, number> {
  const scores = new Map<number, number>();
  for (const r of results) scores.set(r.tableId, resultNsScore(r));

  const mp = new Map<number, number>();
  const add = (pairId: number, v: number) =>
    mp.set(pairId, (mp.get(pairId) ?? 0) + v);

  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i]!;
      const b = results[j]!;
      const sa = scores.get(a.tableId)!;
      const sb = scores.get(b.tableId)!;
      // a 桌 NS 牌号 vs b 桌 NS 牌号
      const aNs = a.nsPairId;
      const aEw = a.ewPairId;
      const bNs = b.nsPairId;
      const bEw = b.ewPairId;
      if (sa > sb) {
        add(aNs, 1); add(bEw, 1);
      } else if (sa < sb) {
        add(bNs, 1); add(aEw, 1);
      } else {
        add(aNs, 0.5); add(bNs, 0.5); add(aEw, 0.5); add(bEw, 0.5);
      }
    }
  }
  return mp;
}

/**
 * 平均 IMP（Butler）：每对每副牌与其余桌该副的基准分比较。
 * 基准分取其余桌 NS 视角分的算术平均（去掉自己这桌），四舍五入到 10。
 */
export function butlerImpForBoard(
  results: BoardResult[],
): Map<number, number> {
  const scores = results.map((r) => resultNsScore(r));
  const out = new Map<number, number>();
  const add = (pairId: number, v: number) =>
    out.set(pairId, (out.get(pairId) ?? 0) + v);

  for (let i = 0; i < results.length; i++) {
    const rest = scores.filter((_, idx) => idx !== i);
    const avg = rest.reduce((a, b) => a + b, 0) / rest.length;
    const datum = Math.round(avg / 10) * 10;
    const diff = scores[i]! - datum;
    const imp = diffToImp(diff);
    const r = results[i]!;
    // NS 方向持 diff 符号；EW 方向相反
    add(r.nsPairId, diff >= 0 ? imp : -imp);
    add(r.ewPairId, diff >= 0 ? -imp : imp);
  }
  return out;
}

/** 一对在整个比赛中的累计 */
export interface PairTotal {
  pairId: number;
  points: number;
  rank: number;
}

/** 把多副牌的每副得分 Map 汇总并排名（分高者列前，并列同名次） */
export function rankPairs(perBoard: Array<Map<number, number>>): PairTotal[] {
  const totals = new Map<number, number>();
  for (const board of perBoard) {
    for (const [pairId, pts] of board) {
      totals.set(pairId, (totals.get(pairId) ?? 0) + pts);
    }
  }
  const arr = [...totals.entries()]
    .map(([pairId, points]) => ({ pairId, points, rank: 0 }))
    .sort((a, b) => b.points - a.points);
  for (let i = 0; i < arr.length; i++) {
    if (i > 0 && arr[i]!.points === arr[i - 1]!.points) {
      arr[i]!.rank = arr[i - 1]!.rank;
    } else {
      arr[i]!.rank = i + 1;
    }
  }
  return arr;
}

/**
 * 队际 IMP：两桌打同一副牌（主客队交换方向），NS 视角分差转带符号 IMP。
 * 返回主队在该副牌的 IMP（主队领先为正）。
 */
export function teamImp(openRoomNs: number, closedRoomNs: number): number {
  return signedImp(openRoomNs - closedRoomNs);
}
