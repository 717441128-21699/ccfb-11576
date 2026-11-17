/**
 * 复式桥牌计分: 定约分、IMP、比赛分 (MP)、交叉 IMP、队式赛 IMP。
 * 局况 Vulnerability: 0 = 无局, 1 = 有局。
 */

import { Seat, Strain, sideOf } from './cards.ts';

export type Vulnerability = 0 | 1; // 0=无局 1=有局
export type Doubled = 0 | 1 | 2; // 0=未加倍 1=加倍 2=再加倍

export interface Contract {
  level: number; // 1..7
  strain: Strain; // 0=C 1=D 2=H 3=S 4=NT
  doubled: Doubled;
  declarer: Seat;
}

export interface BoardScoreInput {
  contract: Contract | null; // null = 全 pass
  /** 庄家一方实际拿到的总墩数 (0..13); 全 pass 时忽略 */
  tricks: number;
  vulnerability: Vulnerability; // 庄家一方的局况
}

const MINOR_TRICK_POINTS = [20, 20, 30, 30, 30]; // 每墩定约分, NT 首墩单独处理
const PART_SCORE_BONUS = 50; // 不成局奖分
const GAME_BONUS = [300, 500]; // [无局, 有局] 成局奖分
const SLAM_BONUS = [
  [500, 750], // 小满贯 [无局, 有局]
  [1000, 1500], // 大满贯 [无局, 有局]
];
const INSULT = [0, 50, 100]; // 做成时的加倍/再加倍奖分
const UNDERTRICK = {
  none: [50, 100],
  doubled: [
    [100, 200, 200, 300, 300, 300, 300], // 无局: 第1墩100, 第2-3墩200, 之后300
    [200, 300, 300, 300, 300, 300, 300], // 有局: 第1墩200, 之后300
  ],
  redoubledMult: 2,
};

/** 计算一副牌的得分 (庄家一方视角, 防守方为相反数) */
export function scoreBoard(input: BoardScoreInput): number {
  const { contract, tricks, vulnerability } = input;
  if (contract === null) return 0;

  const need = contract.level + 6;
  const made = tricks - need; // 超额墩数, 负数表示宕

  if (made < 0) {
    const under = -made;
    if (contract.doubled === 0) {
      return -under * UNDERTRICK.none[vulnerability]!;
    }
    const table = UNDERTRICK.doubled[vulnerability]!;
    let penalty = 0;
    for (let i = 0; i < under; i++) {
      penalty += table[Math.min(i, table.length - 1)]!;
    }
    if (contract.doubled === 2) penalty *= UNDERTRICK.redoubledMult;
    return -penalty;
  }

  // 做成
  const perTrick = MINOR_TRICK_POINTS[contract.strain]!;
  let trickPoints = perTrick * contract.level;
  if (contract.strain === 4) trickPoints += 10; // NT 首墩 +10
  if (contract.doubled === 1) trickPoints *= 2;
  else if (contract.doubled === 2) trickPoints *= 4;

  let score = trickPoints;

  // 成局判定看定约分本身 (加倍后)
  const isGame = trickPoints >= 100;
  score += isGame ? GAME_BONUS[vulnerability]! : PART_SCORE_BONUS;

  if (contract.level === 6) score += SLAM_BONUS[0]![vulnerability]!;
  if (contract.level === 7) score += SLAM_BONUS[1]![vulnerability]!;

  score += INSULT[contract.doubled]!;

  // 超墩
  if (made > 0) {
    if (contract.doubled === 0) {
      score += made * perTrick;
    } else {
      const overPer = vulnerability === 0 ? 100 : 200;
      let over = made * overPer;
      if (contract.doubled === 2) over *= 2;
      score += over;
    }
  }

  return score;
}

/** 转换成某一方视角的得分 (NS 视角) */
export function nsScore(declarer: Seat, declarerScore: number): number {
  return sideOf(declarer) === 0 ? declarerScore : -declarerScore;
}

// ---------------------------------------------------------------- IMP 表

// 标准 IMP 表各档下界 (含): 0, 20, 50, 90, 130, ... 共 25 档 (0..24)
const IMP_LOWER_BOUNDS = [0, 20, 50, 90, 130, 170, 220, 270, 320, 370, 430, 500, 600, 750, 900, 1100, 1300, 1500, 1750, 2000, 2250, 2500, 3000, 3500, 4000];

export function impDifference(diff: number): number {
  const d = Math.abs(diff);
  let imp = 0;
  for (let i = 0; i < IMP_LOWER_BOUNDS.length; i++) {
    if (d >= IMP_LOWER_BOUNDS[i]!) imp = i;
    else break;
  }
  return imp;
}

// ---------------------------------------------------------------- 比赛分

/**
 * 双人赛比赛分 (Mitchell / Howell 通用):
 * 每副牌把同方向各对的得分两两比较, 胜 1 分、平 0.5、负 0。
 * scores: 同方向各对在这副牌上的 NS 视角得分。
 * 返回与输入等长的比赛分数组 (满分 = 比较次数 = n-1)。
 */
export function matchpoints(scores: number[]): number[] {
  const n = scores.length;
  const mp = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (scores[i]! > scores[j]!) mp[i]! += 1;
      else if (scores[i]! < scores[j]!) mp[j]! += 1;
      else {
        mp[i]! += 0.5;
        mp[j]! += 0.5;
      }
    }
  }
  return mp;
}

/**
 * 交叉 IMP: 每个得分与同方向其余所有得分比较, IMP 差值求和。
 * 返回与输入等长的数组 (未平均的总 IMP)。
 */
export function crossImps(scores: number[]): number[] {
  const n = scores.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = scores[i]! - scores[j]!;
      out[i]! += d > 0 ? impDifference(d) : d < 0 ? -impDifference(d) : 0;
    }
  }
  return out;
}

/** 队式赛两桌 IMP: 两桌同副牌 NS 视角分差换算 */
export function teamImp(nsScoreAtTable1: number, nsScoreAtTable2: number): number {
  return impDifference(nsScoreAtTable1 - nsScoreAtTable2);
}

/** 给带总分的实体排名; 并列同名次, 返回 1 起始的名次数组 */
export function rankByTotal(totals: { id: string; total: number }[]): { id: string; total: number; rank: number }[] {
  const sorted = totals.slice().sort((a, b) => b.total - a.total);
  const out: { id: string; total: number; rank: number }[] = [];
  let prev: number | null = null;
  let prevRank = 0;
  sorted.forEach((row, i) => {
    if (prev !== null && row.total === prev) {
      out.push({ ...row, rank: prevRank });
    } else {
      prevRank = i + 1;
      out.push({ ...row, rank: prevRank });
    }
    prev = row.total;
  });
  return out;
}
