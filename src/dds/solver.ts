import {
  type Seat,
  type Suit,
  type Trump,
  NT,
  nextSeat,
  seatSide,
} from '../cards.js';
import type { Deal, Hand } from '../deal.js';
import { mulberry32 } from '../rng.js';
import {
  TranspositionTable,
  BOUND_EXACT,
  BOUND_LOWER,
  BOUND_UPPER,
} from './transposition.js';

/**
 * 双明手搜索引擎（带置换表的 Alpha-Beta）。
 *
 * 关键设计：
 *  - 牌局用四家 × 四花色的 13 位掩码，出牌即按位清除；
 *  - 搜索值始终是“含已赢墩在内的 NS 总拿墩数”，Alpha/Beta 窗口也基于总墩数，
 *    这样窗口剪枝与墩的累加天然自洽（不会把钳制值重复累加）；
 *  - 置换表存的是“未来墩数”（= 节点总墩数 − 该节点已赢墩数 nsTricks），
 *    因此表键【不含】nsTricks，不同出牌路径到达的同一残局可共享表项；
 *  - 64 位 Zobrist 增量哈希；表项记录边界类型与最佳走法（走法排序）；
 *  - fail-soft + 正确的边界分类；
 *  - 同花色连张等牌合并（所有更大余牌都在自己手里才等价）；
 *  - 走法用位掩码直接迭代，热路径零数组分配；
 *  - 根节点首问全窗口打底，之后 MTD(f) 零窗口二分逼近。
 */

export interface SolveOptions {
  firstGuess?: number;
}

export interface SolveResult {
  /** NS 方在剩余牌中能拿到的墩数（根节点 nsTricks=0，即总墩数） */
  nsTricks: number;
  nodes: number;
}

const FULL_WINDOW_ALPHA = -1;
const FULL_WINDOW_BETA = 14;
const TT_LOG_SIZE = 21;

function popcount(mask: number): number {
  let n = 0;
  while (mask !== 0) {
    mask &= mask - 1;
    n++;
  }
  return n;
}

/** 保留掩码中最低（牌点最小）的 n 个 bit */
function keepLowest(mask: number, n: number): number {
  let out = 0;
  let take = n;
  let m = mask;
  while (m !== 0 && take > 0) {
    const bit = m & -m;
    out |= bit;
    m ^= bit;
    take--;
  }
  return out;
}

let zobrist1Shared: Uint32Array | null = null;
let zobrist2Shared: Uint32Array | null = null;

function getZobrist(): { z1: Uint32Array; z2: Uint32Array } {
  if (!zobrist1Shared || !zobrist2Shared) {
    const rng1 = mulberry32(0x9e3779b9);
    const rng2 = mulberry32(0x85ebca6b);
    zobrist1Shared = new Uint32Array(52 * 4);
    zobrist2Shared = new Uint32Array(52 * 4);
    for (let i = 0; i < 52 * 4; i++) {
      zobrist1Shared[i] = Math.floor(rng1() * 0x100000000);
      zobrist2Shared[i] = Math.floor(rng2() * 0x100000000);
    }
  }
  return { z1: zobrist1Shared, z2: zobrist2Shared };
}

export class DDSolver {
  private readonly hands: Deal;
  private readonly tt: TranspositionTable;
  private readonly zobrist1: Uint32Array;
  private readonly zobrist2: Uint32Array;
  private hash1 = 0;
  private hash2 = 0;
  nodeCount = 0;
  /** 节点预算，超过则中止（仅性能探针用），0 表示不限 */
  nodeBudget = 0;
  aborted = false;
  /** 杀手走法表：killer[depth][0/1] 为该深度引发剪枝的走法 card 编号 */
  private readonly killer: Int32Array;
  /** 历史启发得分：history[card] 累计该走法引发剪枝的权重 */
  private readonly history: Int32Array;

  constructor(deal: Deal, tt?: TranspositionTable) {
    this.hands = [
      [...deal[0]] as Hand,
      [...deal[1]] as Hand,
      [...deal[2]] as Hand,
      [...deal[3]] as Hand,
    ];
    this.tt = tt ?? new TranspositionTable(TT_LOG_SIZE);
    this.killer = new Int32Array(14 * 2).fill(-1);
    this.history = new Int32Array(52);
    const { z1, z2 } = getZobrist();
    this.zobrist1 = z1;
    this.zobrist2 = z2;
    for (let seat = 0; seat < 4; seat++) {
      for (let suit = 0; suit < 4; suit++) {
        let mask = this.hands[seat]![suit]!;
        while (mask) {
          const bit = mask & -mask;
          const rank = 32 - Math.clz32(bit) + 1;
          const card = suit * 13 + (rank - 2);
          this.hash1 = (this.hash1 + this.zobrist1[card * 4 + seat]!) >>> 0;
          this.hash2 = (this.hash2 ^ this.zobrist2[card * 4 + seat]!) >>> 0;
          mask ^= bit;
        }
      }
    }
  }

  get transpositionTable(): TranspositionTable {
    return this.tt;
  }

  private countCardsLeft(): number {
    let n = 0;
    for (let seat = 0; seat < 4; seat++) {
      for (let suit = 0; suit < 4; suit++) {
        let m = this.hands[seat]![suit]!;
        while (m) {
          m &= m - 1;
          n++;
        }
      }
    }
    return n;
  }

  /**
   * 求解：指定将牌（4=无将）与首引座位，返回 NS 方在剩余牌中能拿到的墩数。
   *
   * 采用 MTD(f)：全程只发零窗口搜索（[beta-1, beta)），窄窗口剪枝远比
   * 全窗口狠；首次用猜测值起步，随后按返回值在 [lower, upper] 内二分收敛。
   * 不做冷启动全窗口——那会退化成接近朴素 minimax 的昂贵搜索。
   */
  solve(trump: Trump, leader: Seat, _opts: SolveOptions = {}): SolveResult {
    this.nodeCount = 0;
    const cardsLeft = this.countCardsLeft();
    const maxTrick = cardsLeft / 4;

    let lower = 0;
    let upper = maxTrick;
    let g = Math.min(maxTrick, Math.max(0, (maxTrick / 2) | 0));
    let guard = 0;
    while (lower < upper && guard++ < 32) {
      // beta 落在 (lower, upper] 内；避免卡在边界
      const beta = g <= lower ? g + 1 : g;
      const candidate = this.alphaBeta(
        trump, leader, beta - 1, beta,
        4, 4, 0, leader, 0, 0, cardsLeft,
      );
      if (candidate >= beta) {
        lower = candidate;
        g = candidate;
      } else {
        upper = candidate;
        g = candidate;
      }
    }
    return { nsTricks: g, nodes: this.nodeCount };
  }

  /**
   * 复盘用：评估某张具体出牌之后 NS 的总拿墩数（含已入账墩）。
   * 不做等牌合并，每张牌可单独评估；通常命中置换表。
   * 墩起始时 leadSuit/winSuit 传 4、winRank 传 0、winSeat 传 current。
   */
  evaluateMove(
    trump: Trump,
    current: Seat,
    leadSuit: Suit | 4,
    winSuit: Suit | 4,
    winRank: number,
    winSeat: Seat,
    nsTricks: number,
    trickIndex: number,
    cardsLeft: number,
    card: number,
  ): number {
    const suit = Math.floor(card / 13) as Suit;
    const rank = (card % 13) + 2;
    return this.playAndRecurse(
      trump, current, suit, rank, leadSuit, winSuit, winRank, winSeat,
      nsTricks, trickIndex, cardsLeft, FULL_WINDOW_ALPHA, FULL_WINDOW_BETA,
    );
  }

  /**
   * Alpha-Beta 主递归。返回 NS 的【总拿墩数】（含 nsTricks）。
   * 置换表里存的是相对 nsTricks 的“未来墩数”，故探测/写入时做窗口平移。
   */
  private alphaBeta(
    trump: Trump,
    current: Seat,
    alpha: number,
    beta: number,
    leadSuit: Suit | 4,
    winSuit: Suit | 4,
    winRank: number,
    winSeat: Seat,
    nsTricks: number,
    trickIndex: number,
    cardsLeft: number,
  ): number {
    this.nodeCount++;
    if (this.nodeBudget > 0 && this.nodeCount > this.nodeBudget) {
      this.aborted = true;
      return nsTricks;
    }
    if (cardsLeft === 0) return nsTricks;

    const isTrickStart = leadSuit === 4;
    const ek1 = (this.hash1 ^ this.contextKey1(trump, current, leadSuit, winSuit, winRank)) >>> 0;
    // 键里不含 trickIndex：它由持牌局面唯一决定，放进去只会切碎本可共享的表项
    const ek2 = (this.hash2 ^ this.contextKey2(winSeat)) >>> 0;
    let packed: number | null = null;
    if (isTrickStart) packed = this.tt.probe(ek1, ek2);
    let ttBestCard = TranspositionTable.noMove;
    if (packed !== null) {
      const bound = TranspositionTable.unpackBound(packed);
      // 表中存未来墩数，加上本节点已赢墩，换算回总墩数再与窗口比较
      const total = TranspositionTable.unpackTricks(packed) + nsTricks;
      ttBestCard = TranspositionTable.unpackBestCard(packed);
      if (bound === BOUND_EXACT) return total;
      if (bound === BOUND_LOWER && total >= beta) return total;
      if (bound === BOUND_UPPER && total <= alpha) return total;
    }

    const startAlpha = alpha;
    const startBeta = beta;
    const hand = this.hands[current]!;
    const following = leadSuit !== 4;
    const canFollow = following && hand[leadSuit as Suit]! !== 0;
    const isMax = seatSide(current) === 0;

    let onlySuit = -1;
    if (following && canFollow) onlySuit = leadSuit as Suit;

    // 唯一合法牌：直接落子
    const onlyCard = this.singleLegalCard(hand, onlySuit);
    if (onlyCard >= 0) {
      const suit = Math.floor(onlyCard / 13) as Suit;
      const rank = (onlyCard % 13) + 2;
      return this.playAndRecurse(
        trump, current, suit, rank, leadSuit, winSuit, winRank, winSeat,
        nsTricks, trickIndex, cardsLeft, alpha, beta,
      );
    }

    let best = isMax ? -1 : 14;
    let bestCard = TranspositionTable.noMove;

    // 置换表最佳走法优先（走法排序）
    if (ttBestCard !== TranspositionTable.noMove &&
        this.isLegal(hand, onlySuit, ttBestCard)) {
      const suit = Math.floor(ttBestCard / 13) as Suit;
      const rank = (ttBestCard % 13) + 2;
      const v = this.playAndRecurse(
        trump, current, suit, rank, leadSuit, winSuit, winRank, winSeat,
        nsTricks, trickIndex, cardsLeft, alpha, beta,
      );
      if (isMax) {
        if (v > best) { best = v; bestCard = ttBestCard; }
        if (best > alpha) alpha = best;
      } else {
        if (v < best) { best = v; bestCard = ttBestCard; }
        if (best < beta) beta = best;
      }
    }

    if (alpha < beta) {
      // 收集候选牌并做静态评分排序。
      // 评分越高越先试：跟牌时“能赢墩”的牌优先，且同类里小牌在前（留住大牌）；
      // 领出时大牌在前。MAX/MIN 共用候选顺序，各自在搜索中取极值。
      const candSuits: Suit[] = [];
      const candRanks: number[] = [];
      const candScore: number[] = [];
      this.collectCandidates(
        trump, hand, onlySuit, leadSuit, winSuit, winRank,
        ttBestCard, trickIndex,
        candSuits, candRanks, candScore,
      );
      // 简单插入排序（候选数 ≤13）
      for (let i = 1; i < candScore.length; i++) {
        const ss = candScore[i]!;
        const cs = candSuits[i]!;
        const cr = candRanks[i]!;
        let j = i - 1;
        while (j >= 0 && candScore[j]! < ss) {
          candScore[j + 1] = candScore[j]!;
          candSuits[j + 1] = candSuits[j]!;
          candRanks[j + 1] = candRanks[j]!;
          j--;
        }
        candScore[j + 1] = ss;
        candSuits[j + 1] = cs;
        candRanks[j + 1] = cr;
      }

      let searchedOne = ttBestCard !== TranspositionTable.noMove &&
        this.isLegal(hand, onlySuit, ttBestCard);

      for (let i = 0; i < candRanks.length && alpha < beta; i++) {
        const suit = candSuits[i]!;
        const rank = candRanks[i]!;
        const card = suit * 13 + (rank - 2);
        // 等牌连张剪枝只在领出（墩首）时安全
        if (leadSuit === 4 && this.isEquivalent(current, suit, rank)) continue;

        let v: number;
        if (searchedOne && beta - alpha > 1) {
          // PVS 侦察：先用零窗口试探
          if (isMax) {
            const scout = this.playAndRecurse(
              trump, current, suit, rank, leadSuit, winSuit, winRank, winSeat,
              nsTricks, trickIndex, cardsLeft, alpha, alpha + 1,
            );
            if (scout > alpha) {
              // fail-high：零窗口容不下，用完整窗口重搜
              v = this.playAndRecurse(
                trump, current, suit, rank, leadSuit, winSuit, winRank, winSeat,
                nsTricks, trickIndex, cardsLeft, alpha, beta,
              );
            } else {
              v = scout;
            }
          } else {
            const scout = this.playAndRecurse(
              trump, current, suit, rank, leadSuit, winSuit, winRank, winSeat,
              nsTricks, trickIndex, cardsLeft, beta - 1, beta,
            );
            if (scout < beta) {
              // fail-low：用完整窗口重搜
              v = this.playAndRecurse(
                trump, current, suit, rank, leadSuit, winSuit, winRank, winSeat,
                nsTricks, trickIndex, cardsLeft, alpha, beta,
              );
            } else {
              v = scout;
            }
          }
        } else {
          v = this.playAndRecurse(
            trump, current, suit, rank, leadSuit, winSuit, winRank, winSeat,
            nsTricks, trickIndex, cardsLeft, alpha, beta,
          );
        }
        searchedOne = true;

        if (isMax) {
          if (v > best) { best = v; bestCard = card; }
          if (best > alpha) alpha = best;
        } else {
          if (v < best) { best = v; bestCard = card; }
          if (best < beta) beta = best;
        }
        // 引发剪枝：登记杀手走法与历史启发
        if (alpha >= beta) {
          this.recordCutoff(card, trickIndex, cardsLeft);
        }
      }
    }

    // fail-soft 边界分类（基于总墩数窗口）
    let bestBound: number;
    if (isMax) {
      bestBound = best <= startAlpha
        ? BOUND_UPPER
        : best >= startBeta ? BOUND_LOWER : BOUND_EXACT;
    } else {
      bestBound = best >= startBeta
        ? BOUND_LOWER
        : best <= startAlpha ? BOUND_UPPER : BOUND_EXACT;
    }
    // 只在墩首写置换表：墩中状态高度依赖本墩上下文、复用率低，
    // 写入反而挤占高复用的按墩状态表项。
    if (isTrickStart) {
      // 存“未来墩数”偏移，使表项与 nsTricks 解耦
      const future = best - nsTricks;
      this.tt.store(
        ek1, ek2,
        TranspositionTable.packValue(future, bestBound, trickIndex, bestCard),
      );
    }
    return best;
  }

  /** 出牌、递归、再把牌放回；返回 NS 总拿墩数（含已入账墩） */
  private playAndRecurse(
    trump: Trump,
    current: Seat,
    suit: Suit,
    rank: number,
    leadSuit: Suit | 4,
    winSuit: Suit | 4,
    winRank: number,
    winSeat: Seat,
    nsTricks: number,
    trickIndex: number,
    cardsLeft: number,
    alpha: number,
    beta: number,
  ): number {
    const hand = this.hands[current]!;
    const bit = 1 << (rank - 2);
    hand[suit] = hand[suit]! ^ bit;
    const card = suit * 13 + (rank - 2);
    const zIndex = card * 4 + current;
    this.hash1 = (this.hash1 - this.zobrist1[zIndex]!) >>> 0;
    this.hash2 = (this.hash2 ^ this.zobrist2[zIndex]!) >>> 0;

    const next = nextSeat(current);
    const playedInTrick = (4 - (cardsLeft % 4)) % 4;
    let value: number;

    if (playedInTrick === 0) {
      // 墩首：这张成为当前赢家
      value = this.alphaBeta(
        trump, next, alpha, beta,
        suit, suit, rank, current, nsTricks, trickIndex, cardsLeft - 1,
      );
    } else {
      let newWinSeat = winSeat;
      let newWinRank = winRank;
      let newWinSuit = winSuit;
      if (this.beatsCard(trump, suit, rank, newWinSuit, newWinRank)) {
        newWinSeat = current;
        newWinRank = rank;
        newWinSuit = suit;
      }
      if (playedInTrick === 3) {
        // 一墩打完：本墩归属入账，再开新墩（赢家首引）
        const newNs = nsTricks + (seatSide(newWinSeat) === 0 ? 1 : 0);
        if (cardsLeft - 1 === 0) {
          value = newNs;
        } else {
          value = this.alphaBeta(
            trump, newWinSeat, alpha, beta,
            4, 4, 0, newWinSeat, newNs, trickIndex + 1, cardsLeft - 1,
          );
        }
      } else {
        value = this.alphaBeta(
          trump, next, alpha, beta,
          leadSuit, newWinSuit, newWinRank, newWinSeat,
          nsTricks, trickIndex, cardsLeft - 1,
        );
      }
    }

    this.hash1 = (this.hash1 + this.zobrist1[zIndex]!) >>> 0;
    this.hash2 = (this.hash2 ^ this.zobrist2[zIndex]!) >>> 0;
    hand[suit] = hand[suit]! | bit;
    return value;
  }

  /** 记录引发剪枝的走法：更新杀手表与历史启发 */
  private recordCutoff(card: number, trickIndex: number, cardsLeft: number): void {
    const depth = trickIndex;
    const base = depth * 2;
    if (this.killer[base] !== card) {
      this.killer[base + 1] = this.killer[base]!;
      this.killer[base] = card;
    }
    // 越浅的剪枝权重越高
    this.history[card] = this.history[card]! + (cardsLeft & 31) + 1;
  }

  private beatsCard(
    trump: Trump,
    suit: Suit,
    rank: number,
    winSuit: Suit | 4,
    winRank: number,
  ): boolean {
    if (suit === winSuit) return rank > winRank;
    return trump !== NT && suit === trump && winSuit !== trump;
  }

  /**
   * 收集候选合法牌并给出静态排序分（分高者先试）。
   *  - 置换表最佳走法已在外部先评估，这里跳过；
   *  - 杀手走法（同深度剪枝过的牌）给高加权；
   *  - 历史启发分叠加；
   *  - 跟牌时能盖过当前赢张的牌优先，且同类里小赢张在前；
   *  - 领出时将牌优先、大牌优先。
   */
  private collectCandidates(
    trump: Trump,
    hand: Hand,
    onlySuit: number,
    leadSuit: Suit | 4,
    winSuit: Suit | 4,
    winRank: number,
    ttBestCard: number,
    trickIndex: number,
    outSuits: Suit[],
    outRanks: number[],
    outScore: number[],
  ): void {
    const k0 = this.killer[trickIndex * 2]!;
    const k1 = this.killer[trickIndex * 2 + 1]!;
    const pushSuit = (suit: Suit, following: boolean) => {
      let mask = hand[suit]!;
      while (mask !== 0) {
        const bit = mask & -mask;
        mask ^= bit;
        const rank = 32 - Math.clz32(bit) + 1;
        const card = suit * 13 + (rank - 2);
        if (card === ttBestCard) continue;
        let score: number;
        if (following) {
          const wins = this.beatsCard(trump, suit, rank, winSuit, winRank);
          score = wins ? 100 + (15 - rank) : rank;
        } else {
          const trumpBonus = trump !== NT && suit === trump ? 40 : 0;
          score = trumpBonus + rank;
        }
        if (card === k0) score += 10_000;
        else if (card === k1) score += 9_000;
        score += Math.min(this.history[card]!, 8_000);
        outSuits.push(suit);
        outRanks.push(rank);
        outScore.push(score);
      }
    };

    if (onlySuit >= 0) {
      pushSuit(onlySuit as Suit, true);
      return;
    }
    if (trump !== NT) pushSuit(trump as Suit, false);
    for (let suit = 0; suit < 4; suit++) {
      if (suit === trump) continue;
      pushSuit(suit as Suit, false);
    }
  }

  /**
   * 等牌连张剪枝（严格安全的自身支配规则），仅在【领出（墩首）】时调用。
   *
   * 经穷举对拍验证：只有当同花色中所有比 rank 大的余牌都在【出牌人自己】
   * 手里时，本张才被自己的大牌严格支配而可跳过。
   *
   * 注意两个经实验证伪、不能采用的放宽：
   *  - 把“在自己手里”放宽成“在己方（自己+对家）手里”会错（对家持大牌时
   *    出牌座位不同，后续控制权与赢墩能力不等价）；
   *  - 在跟牌位置启用同样会错（本墩已有临时赢张）。
   * 故这里刻意保守，宁少剪不错剪。
   */
  private isEquivalent(current: Seat, suit: Suit, rank: number): boolean {
    let combined = 0;
    for (let seat = 0; seat < 4; seat++) combined |= this.hands[seat as Seat]![suit]!;
    const higher = combined & ~((1 << (rank - 1)) - 1);
    if (higher === 0) return false;
    return (this.hands[current]![suit]! & higher) === higher;
  }

  /** 只剩一张合法牌时返回其 card 编号，否则 -1 */
  private singleLegalCard(hand: Hand, onlySuit: number): number {
    if (onlySuit >= 0) {
      const mask = hand[onlySuit]!;
      if (mask && (mask & (mask - 1)) === 0) {
        const rank = 32 - Math.clz32(mask) + 1;
        return onlySuit * 13 + (rank - 2);
      }
      return -1;
    }
    let found = -1;
    for (let suit = 0; suit < 4; suit++) {
      let mask = hand[suit]!;
      while (mask) {
        const bit = mask & -mask;
        if (found >= 0) return -1;
        const rank = 32 - Math.clz32(bit) + 1;
        found = suit * 13 + (rank - 2);
        mask ^= bit;
      }
    }
    return found;
  }

  private isLegal(hand: Hand, onlySuit: number, card: number): boolean {
    const suit = Math.floor(card / 13) as Suit;
    const rank = (card % 13) + 2;
    if (onlySuit >= 0 && suit !== onlySuit) return false;
    return (hand[suit]! & (1 << (rank - 2))) !== 0;
  }

  private contextKey1(
    trump: Trump,
    current: Seat,
    leadSuit: Suit | 4,
    winSuit: Suit | 4,
    winRank: number,
  ): number {
    return (
      (trump + 1) * 7919 +
      (current + 1) * 104729 +
      (leadSuit + 1) * 1299709 +
      (winSuit + 1) * 15485863 +
      winRank * 32452843
    ) >>> 0;
  }

  private contextKey2(winSeat: Seat): number {
    return ((winSeat + 1) * 49979687) >>> 0;
  }
}

/** 一副完整牌局的 20 个双明手结果：[trump 0..4][leader 0..3]，值为 NS 拿墩数 */
export type DoubleDummyTable = number[][];

export function solveFullTable(
  deal: Deal,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): { table: DoubleDummyTable; totalNodes: number; millis: number } {
  const start = performance.now();
  const solver = new DDSolver(deal);
  const table: DoubleDummyTable = [[], [], [], [], []];
  let totalNodes = 0;
  let done = 0;
  let guess = 6;
  for (let trump = 0; trump <= 4; trump++) {
    for (let leader = 0; leader < 4; leader++) {
      const r = solver.solve(trump as Trump, leader as Seat, { firstGuess: guess });
      table[trump]![leader] = r.nsTricks;
      totalNodes += r.nodes;
      guess = r.nsTricks;
      opts.onProgress?.(++done, 20);
    }
  }
  return { table, totalNodes, millis: performance.now() - start };
}

/** 由完整 DDT 取某定约方的拿墩数（庄家的下家首引） */
export function tricksForDeclarer(
  table: DoubleDummyTable,
  trump: Trump,
  declarer: Seat,
): number {
  const leader = nextSeat(declarer);
  const nsTricks = table[trump]![leader]!;
  return seatSide(declarer) === 0 ? nsTricks : 13 - nsTricks;
}
