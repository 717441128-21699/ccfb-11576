/**
 * 复盘引擎: 在一副完整牌上逐墩演示, 实时标注最佳出法与失误代价。
 * 双明手视角下, 每个轮到出牌的座位都能算出当前所有合法着法的最优结果。
 */

import { Hands, Seat, Strain, Suit, nextSeat, sideOf, popcount, lowestBitIndex, highestBitIndex } from './cards.ts';
import { DoubleDummySolver, TranspositionTable, type PlayedCard } from './dds.ts';

export interface MoveAssessment {
  suit: Suit;
  rankIdx: number;
  /** 走完这张后, 该行棋方一方在剩余牌中能拿到的总墩数 (含已落袋) */
  sideTricks: number;
  /** 是否为最优着法之一 */
  isBest: boolean;
  /** 相对最优着法损失的墩数 (0 = 最优) */
  loss: number;
}

export interface ReviewState {
  hands: Hands; // 当前各家剩余牌
  strain: Strain;
  turn: Seat;
  currentTrick: PlayedCard[];
  completedTricks: PlayedCard[][];
  /** NS 已落袋墩数 */
  nsBanked: number;
  /** EW 已落袋墩数 */
  ewBanked: number;
  /** 当前轮到方的合法着法评估 (未出牌时) */
  assessments: MoveAssessment[];
  /** 整副牌双明手最优时, 当前行棋方一方的目标总墩数 */
  targetTricks: number;
  finished: boolean;
}

export class ReviewEngine {
  private hands: Hands;
  private readonly strain: Strain;
  private readonly tt: TranspositionTable;
  private turn: Seat;
  private currentTrick: PlayedCard[] = [];
  private completedTricks: PlayedCard[][] = [];
  private nsBanked = 0;
  private ewBanked = 0;
  private readonly leader: Seat;

  constructor(hands: Hands, strain: Strain, leader: Seat, tt?: TranspositionTable) {
    this.hands = hands.map((h) => h.slice());
    this.strain = strain;
    this.leader = leader;
    this.turn = leader;
    this.tt = tt ?? new TranspositionTable();
  }

  private trump(): Suit | null {
    return this.strain === 4 ? null : (this.strain as Suit);
  }

  /** 当前行棋方的合法着法 (花色掩码数组) */
  private legalMasks(): number[] {
    const masks = [0, 0, 0, 0];
    const h = this.hands[this.turn]!;
    if (this.currentTrick.length > 0) {
      const leadSuit = this.currentTrick[0]!.suit;
      if (h[leadSuit] !== 0) {
        masks[leadSuit] = h[leadSuit]!;
        return masks;
      }
    }
    for (let s = 0; s < 4; s++) masks[s] = h[s]!;
    return masks;
  }

  private trickWinner(cards: PlayedCard[]): Seat {
    const trump = this.trump();
    let win = cards[0]!;
    for (let i = 1; i < cards.length; i++) {
      const c = cards[i]!;
      const beats =
        c.suit === win.suit
          ? c.rankIdx > win.rankIdx
          : trump !== null && c.suit === trump && win.suit !== trump;
      if (beats) win = c;
    }
    return win.seat;
  }

  /** 评估一张候选着法走完后的局面, 返回行棋方一方的总墩数 */
  private evaluateMove(suit: Suit, rankIdx: number): number {
    const moveSide = sideOf(this.turn);
    // 模拟出牌
    const snapHands = this.hands.map((h) => h.slice());
    const snapTrick = this.currentTrick.map((c) => ({ ...c }));
    const snapTurn = this.turn;
    const snapNs = this.nsBanked;
    const snapEw = this.ewBanked;

    this.hands[this.turn]![suit]! &= ~(1 << rankIdx);
    this.currentTrick.push({ seat: this.turn, suit, rankIdx });
    let nextTurn: Seat = nextSeat(this.turn);
    let settled = false;
    if (this.currentTrick.length === 4) {
      const winner = this.trickWinner(this.currentTrick);
      if (sideOf(winner) === 0) this.nsBanked++;
      else this.ewBanked++;
      nextTurn = winner;
      settled = true;
      this.completedTricks.push(this.currentTrick);
      this.currentTrick = [];
    }
    this.turn = nextTurn;

    // 用 DDS 评估剩余局面 (共享热 TT)
    const solver = new DoubleDummySolver(this.hands, this.strain, this.tt);
    let futureNS: number;
    const remaining = this.hands.reduce((n, hh) => n + hh.reduce((m, x) => m + popcount(x), 0), 0);
    if (remaining === 0) {
      futureNS = 0;
    } else {
      futureNS = solver.evaluate(this.hands, this.currentTrick, this.turn);
    }
    const totalNS = this.nsBanked + futureNS;

    // 恢复
    this.hands = snapHands;
    this.currentTrick = snapTrick;
    this.turn = snapTurn;
    this.nsBanked = snapNs;
    this.ewBanked = snapEw;
    if (settled) this.completedTricks.pop();

    return moveSide === 0 ? totalNS : 13 - totalNS;
  }

  /** 生成当前局面的全部着法评估 */
  assess(): MoveAssessment[] {
    if (this.isFinished()) return [];
    const masks = this.legalMasks();
    const raw: MoveAssessment[] = [];
    for (let s = 0; s < 4; s++) {
      let m = masks[s]!;
      while (m) {
        const b = m & -m;
        m ^= b;
        const rankIdx = lowestBitIndex(b);
        const sideTricks = this.evaluateMove(s as Suit, rankIdx);
        raw.push({ suit: s as Suit, rankIdx, sideTricks, isBest: false, loss: 0 });
      }
    }
    const best = Math.max(...raw.map((r) => r.sideTricks));
    for (const r of raw) {
      r.isBest = r.sideTricks === best;
      r.loss = best - r.sideTricks;
    }
    // 排序: 最优在前, 同值按花色点位
    raw.sort((a, b) => b.sideTricks - a.sideTricks || a.suit - b.suit || a.rankIdx - b.rankIdx);
    return raw;
  }

  /** 实际打出一张牌, 推进局面; 返回这张牌的失误墩数 */
  play(suit: Suit, rankIdx: number): number {
    const assessments = this.assess();
    const chosen = assessments.find((a) => a.suit === suit && a.rankIdx === rankIdx);
    const loss = chosen?.loss ?? 0;

    this.hands[this.turn]![suit]! &= ~(1 << rankIdx);
    this.currentTrick.push({ seat: this.turn, suit, rankIdx });
    if (this.currentTrick.length === 4) {
      const winner = this.trickWinner(this.currentTrick);
      if (sideOf(winner) === 0) this.nsBanked++;
      else this.ewBanked++;
      this.completedTricks.push(this.currentTrick);
      this.currentTrick = [];
      this.turn = winner;
    } else {
      this.turn = nextSeat(this.turn);
    }
    return loss;
  }

  isFinished(): boolean {
    const remaining = this.hands.reduce((n, hh) => n + hh.reduce((m, x) => m + popcount(x), 0), 0);
    return remaining === 0 && this.currentTrick.length === 0;
  }

  getState(): ReviewState {
    const assessments = this.assess();
    const target = assessments.length > 0 ? Math.max(...assessments.map((a) => a.sideTricks)) : 0;
    return {
      hands: this.hands.map((h) => h.slice()),
      strain: this.strain,
      turn: this.turn,
      currentTrick: this.currentTrick.map((c) => ({ ...c })),
      completedTricks: this.completedTricks.map((t) => t.map((c) => ({ ...c }))),
      nsBanked: this.nsBanked,
      ewBanked: this.ewBanked,
      assessments,
      targetTricks: target,
      finished: this.isFinished(),
    };
  }

  getLeader(): Seat {
    return this.leader;
  }
}

/** 全副牌双明手最优墩数 (某方视角), 用于开局目标展示 */
export function optimalTricksForSide(
  hands: Hands,
  strain: Strain,
  leader: Seat,
  tt: TranspositionTable,
): { nsTricks: number; ewTricks: number } {
  const solver = new DoubleDummySolver(hands, strain, tt);
  const ns = solver.solveFromTrickStart(leader);
  return { nsTricks: ns, ewTricks: 13 - ns };
}

void highestBitIndex;
