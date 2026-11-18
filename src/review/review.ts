import {
  type Seat,
  type Suit,
  type Trump,
  NT,
  nextSeat,
  seatSide,
  cardSuit,
  cardRank,
} from '../cards.js';
import type { Deal } from '../deal.js';
import { cloneDeal, removeCard } from '../deal.js';
import { DDSolver } from '../dds/solver.js';

/**
 * 复盘引擎：在一副牌上逐张出牌，实时标注每张合法牌是否为双明手最佳出法，
 * 并在会员出错时给出“这手丢了几墩”。
 *
 * 双明手最佳的定义：从当前局面出发，按最佳攻防能拿到的总墩数（NS 视角）。
 * 一张牌是最佳的，当且仅当打出它之后，己方仍能达到当前局面的最优总墩数。
 */

export interface PlayedCard {
  seat: Seat;
  card: number;
}

export interface MoveEvaluation {
  card: number;
  /** 打出这张后，NS 方能拿到的总墩数 */
  nsTricksAfter: number;
  /** 是否为当前局面的最佳出法之一（可能多张并列最佳） */
  isBest: boolean;
  /** 相对最佳出法损失的墩数（0 表示最佳） */
  tricksLost: number;
}

export interface ReviewStateData {
  trump: Trump;
  /** 剩余持牌（随出牌更新） */
  hands: Deal;
  /** 已出牌序列 */
  history: PlayedCard[];
  /** 当前轮到的座位 */
  current: Seat;
  /** 本墩首引花色，墩起始为 4 */
  leadSuit: Suit | 4;
  /** 本墩临时赢家 */
  winSuit: Suit | 4;
  winRank: number;
  winSeat: Seat;
  /** 已完成墩中 NS 拿到的墩数 */
  nsTricks: number;
  /** 当前墩序号 0..12 */
  trickIndex: number;
  /** 全桌剩余牌数 */
  cardsLeft: number;
  /** 已完成的墩（每墩 4 张），便于回放展示 */
  completedTricks: PlayedCard[][];
  /** 当前墩已出的牌 */
  currentTrick: PlayedCard[];
}

export class ReviewEngine {
  private readonly initial: Deal;
  private hands: Deal;
  private readonly solver: DDSolver;
  readonly trump: Trump;
  private history: PlayedCard[] = [];
  private current: Seat;
  private leadSuit: Suit | 4 = NT;
  private winSuit: Suit | 4 = NT;
  private winRank = 0;
  private winSeat: Seat;
  private nsTricks = 0;
  private trickIndex = 0;
  private cardsLeft: number;
  private completedTricks: PlayedCard[][] = [];
  private currentTrick: PlayedCard[] = [];

  constructor(deal: Deal, trump: Trump, leader: Seat) {
    this.initial = cloneDeal(deal);
    this.hands = cloneDeal(deal);
    this.trump = trump;
    this.current = leader;
    this.winSeat = leader;
    this.cardsLeft = this.countCards();
    this.solver = new DDSolver(this.hands);
  }

  private countCards(): number {
    let n = 0;
    for (let seat = 0; seat < 4; seat++) {
      for (let suit = 0; suit < 4; suit++) {
        let m = this.hands[seat]![suit]!;
        while (m !== 0) { m &= m - 1; n++; }
      }
    }
    return n;
  }

  get state(): ReviewStateData {
    return {
      trump: this.trump,
      hands: cloneDeal(this.hands),
      history: [...this.history],
      current: this.current,
      leadSuit: this.leadSuit,
      winSuit: this.winSuit,
      winRank: this.winRank,
      winSeat: this.winSeat,
      nsTricks: this.nsTricks,
      trickIndex: this.trickIndex,
      cardsLeft: this.cardsLeft,
      completedTricks: this.completedTricks.map((t) => [...t]),
      currentTrick: [...this.currentTrick],
    };
  }

  get isDone(): boolean {
    return this.cardsLeft === 0;
  }

  /** 当前出牌人手里的合法牌（card 编号数组） */
  legalMoves(): number[] {
    const hand = this.hands[this.current]!;
    const out: number[] = [];
    if (this.leadSuit !== NT && hand[this.leadSuit]! !== 0) {
      this.pushSuitCards(this.leadSuit, hand[this.leadSuit]!, out);
      return out;
    }
    for (let suit = 0; suit < 4; suit++) {
      this.pushSuitCards(suit as Suit, hand[suit as Suit]!, out);
    }
    return out;
  }

  private pushSuitCards(suit: Suit, mask: number, out: number[]): void {
    let m = mask;
    while (m !== 0) {
      const bit = m & -m;
      m ^= bit;
      const rank = 32 - Math.clz32(bit) + 1;
      out.push(suit * 13 + (rank - 2));
    }
  }

  /**
   * 评估当前所有合法牌：每张牌打出后的 NS 总墩数、是否最佳、丢墩数。
   * 这是复盘界面“实时标出最佳出法”的数据源。
   */
  evaluateLegalMoves(): MoveEvaluation[] {
    if (this.isDone) return [];
    const moves = this.legalMoves();
    const results: MoveEvaluation[] = [];
    const isMaxSide = seatSide(this.current) === 0;

    for (const card of moves) {
      const nsAfter = this.solver.evaluateMove(
        this.trump, this.current, this.leadSuit, this.winSuit,
        this.winRank, this.winSeat, this.nsTricks, this.trickIndex,
        this.cardsLeft, card,
      );
      results.push({ card, nsTricksAfter: nsAfter, isBest: false, tricksLost: 0 });
    }

    // 本方视角的最优基准：MAX 方取 NS 墩数最大，MIN 方取 NS 墩数最小
    const nsValues = results.map((r) => r.nsTricksAfter);
    const bestForSide = isMaxSide ? Math.max(...nsValues) : Math.min(...nsValues);

    for (const r of results) {
      // 丢墩：与本方可达成的最优结果之差（恒非负）
      r.tricksLost = isMaxSide
        ? bestForSide - r.nsTricksAfter
        : r.nsTricksAfter - bestForSide;
      r.isBest = r.tricksLost === 0;
    }
    return results;
  }

  /** 打出一张牌，推进局面；返回更新后的状态 */
  play(card: number): ReviewStateData {
    if (this.isDone) throw new Error('牌已出完');
    const seat = this.current;
    const suit = cardSuit(card);
    const rank = cardRank(card);
    if ((this.hands[seat]![suit]! & (1 << (rank - 2))) === 0) {
      throw new Error('该座位没有这张牌');
    }
    // 合法性：跟牌必须同花色
    if (this.leadSuit !== NT && this.hands[seat]![this.leadSuit]! !== 0 &&
        suit !== this.leadSuit) {
      throw new Error('必须跟出首引花色');
    }

    removeCard(this.hands, seat, card);
    this.history.push({ seat, card });
    this.currentTrick.push({ seat, card });
    this.cardsLeft--;

    const playedInTrick = this.currentTrick.length;
    if (playedInTrick === 1) {
      // 墩首
      this.leadSuit = suit;
      this.winSuit = suit;
      this.winRank = rank;
      this.winSeat = seat;
    } else if (this.beats(suit, rank, this.winSuit, this.winRank)) {
      this.winSuit = suit;
      this.winRank = rank;
      this.winSeat = seat;
    }

    if (playedInTrick === 4) {
      // 一墩结束
      if (seatSide(this.winSeat) === 0) this.nsTricks++;
      this.completedTricks.push([...this.currentTrick]);
      this.currentTrick = [];
      this.current = this.winSeat;
      this.leadSuit = NT;
      this.winSuit = NT;
      this.winRank = 0;
      this.trickIndex++;
      if (!this.isDone) this.winSeat = this.current;
    } else {
      this.current = nextSeat(seat);
    }
    return this.state;
  }

  private beats(suit: Suit, rank: number, winSuit: Suit | 4, winRank: number): boolean {
    if (suit === winSuit) return rank > winRank;
    return this.trump !== NT && suit === this.trump && winSuit !== this.trump;
  }
}
