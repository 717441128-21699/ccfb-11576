import { type Trump, NT, type Seat, seatSide } from '../cards.js';

/**
 * 桥牌定约与计分（WBF 标准复式赛规则）。
 */

/** 局况：0=双方无局 1=南北有局 2=东西有局 3=双方有局 */
export type Vulnerability = 0 | 1 | 2 | 3;
export const VUL_NONE = 0;
export const VUL_NS = 1;
export const VUL_EW = 2;
export const VUL_BOTH = 3;

export interface Contract {
  /** 阶数 1..7 */
  level: number;
  /** 将牌 0..3，4=无将 */
  trump: Trump;
  /** 庄家座位 */
  declarer: Seat;
  /** 加倍：0=未加倍 1=加倍 2=再加倍 */
  doubled: 0 | 1 | 2;
}

export interface PlayResult {
  /** 庄家方实际拿到的墩数 */
  tricks: number;
}

export interface ScoreResult {
  /** 定约方（庄家所在一方）的得分，正负表示 NS 视角 */
  score: number;
  /** 正分归属一方：0=NS 1=EW */
  scoreSide: 0 | 1;
  made: boolean;
  /** 做成时超出定约的墩数（超墩），宕时为负的宕墩数 */
  overUnder: number;
}

const MINOR = [0, 1]; // 草花、方块
const MAJOR = [2, 3]; // 红桃、黑桃

function isVulnerable(vul: Vulnerability, side: 0 | 1): boolean {
  if (vul === VUL_BOTH) return true;
  if (vul === VUL_NONE) return false;
  return vul === VUL_NS ? side === 0 : side === 1;
}

/**
 * 计算一个定约的得分。
 * 返回 scoreSide 一方获得 score 分（score 恒为非负，归属由 scoreSide 表示）。
 */
export function scoreContract(
  contract: Contract,
  result: PlayResult,
  vul: Vulnerability,
): ScoreResult {
  const { level, trump, declarer, doubled } = contract;
  const side = seatSide(declarer);
  const vulnerable = isVulnerable(vul, side);
  const need = level + 6;
  const overUnder = result.tricks - need;
  const made = overUnder >= 0;

  if (!made) {
    const down = -overUnder;
    const penalty = penaltyPoints(down, vulnerable, doubled);
    return { score: penalty, scoreSide: side === 0 ? 1 : 0, made: false, overUnder };
  }

  let score = 0;
  // 墩分
  let trickPoints = 0;
  if (trump === NT) {
    trickPoints = 40 + (level - 1) * 30;
  } else if (MAJOR.includes(trump)) {
    trickPoints = level * 30;
  } else {
    trickPoints = level * 20;
  }

  // 加倍对墩分的修正
  let actualTrickPoints = trickPoints;
  if (doubled === 1) actualTrickPoints *= 2;
  else if (doubled === 2) actualTrickPoints *= 4;
  score += actualTrickPoints;

  // 奖分
  const game = trickPoints >= 100;
  if (doubled === 0) {
    if (game) score += vulnerable ? 500 : 300;
    else score += 50; // 部分定约奖分
    if (level === 7) score += vulnerable ? 1500 : 1000; // 大满贯
    else if (level === 6) score += vulnerable ? 750 : 500; // 小满贯
  } else {
    // 加倍/再加倍定约
    score += doubled === 2 ? 100 : 50; // 侮辱性奖分
    if (game) score += vulnerable ? 500 : 300;
    else score += 50;
    if (level === 7) score += vulnerable ? 1500 : 1000;
    else if (level === 6) score += vulnerable ? 750 : 500;
  }

  // 超墩
  if (overUnder > 0) {
    if (doubled === 0) {
      const per = trump === NT || MAJOR.includes(trump) ? 30 : 20;
      score += overUnder * per;
    } else {
      // 加倍超墩：有局 200/400，无局 100/200（再加倍翻倍）
      const per = vulnerable ? 200 : 100;
      let over = overUnder * per;
      if (doubled === 2) over *= 2;
      score += over;
    }
  }

  return { score, scoreSide: side, made: true, overUnder };
}

/** 宕分（罚分），返回定约方输给对方的分数 */
function penaltyPoints(down: number, vulnerable: boolean, doubled: 0 | 1 | 2): number {
  if (doubled === 0) {
    return down * (vulnerable ? 100 : 50);
  }
  // 加倍宕分表
  let points: number;
  if (vulnerable) {
    // 有局：首宕 200，其后每宕 300
    points = 200 + (down - 1) * 300;
  } else {
    // 无局：1=100 2=300 3=500 其后每宕 300
    if (down === 1) points = 100;
    else if (down === 2) points = 300;
    else if (down === 3) points = 500;
    else points = 500 + (down - 3) * 300;
  }
  return doubled === 2 ? points * 2 : points;
}

/**
 * 把得分统一换算成 NS 视角的带符号分数（NS 得正、EW 得负）。
 */
export function toNsSigned(r: ScoreResult): number {
  return r.scoreSide === 0 ? r.score : -r.score;
}

export function contractName(c: Contract): string {
  const trumpChar = c.trump === NT ? 'NT' : ['♣', '♦', '♥', '♠'][c.trump];
  const dbl = c.doubled === 2 ? 'XX' : c.doubled === 1 ? 'X' : '';
  return `${c.level}${trumpChar}${dbl} ${['N', 'E', 'S', 'W'][c.declarer]}`;
}
