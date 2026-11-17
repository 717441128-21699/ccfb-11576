/**
 * 双明手求解器
 *
 * 搜索: 零和 Alpha-Beta, 评估值为 NS 一方在剩余牌中能拿到的墩数。
 * 置换表: 开放寻址 (线性探测), 双 32 位 Zobrist 校验防碰撞;
 *         只在每墩开始处存取, 同一将牌下四个庄位共享一张表。
 * 剪枝:
 *   1. 等价牌合并 —— 同一手牌中相邻且中间没有其他家持牌的连张完全等价,
 *      每组只保留一张代表牌 (大牌)。
 *   2. 同伴已铁定赢下本墩且自己最后出牌时, 每组合法花色只出最小牌。
 *   3. Alpha-Beta + 置换表窗口 (EXACT / LOWER / UPPER)。
 */

import {
  Hands,
  Seat,
  Strain,
  Suit,
  NT,
  nextSeat,
  partnerSeat,
  sideOf,
  popcount,
  highestBitIndex,
  lowestBitIndex,
  makeRng,
} from './cards.ts';

export interface DDSStats {
  nodes: number;
  ttStores: number;
  ttHits: number;
}

const DEFAULT_TT_LOG2 = 22; // 默认 ~400 万槽, 实测在该规模命中率饱和
const MAX_PROBES = 8;
const EMPTY_LO = 0;

/**
 * 置换表 (按将牌分别持有, 不可跨将牌复用: 哈希不含将牌信息)。
 * 同一副牌同一将牌下的四个庄位求解、以及复盘中的逐张评估共享一张表。
 */
export class TranspositionTable {
  readonly size: number;
  readonly lo: Uint32Array;
  readonly hi: Uint32Array;
  readonly val: Int8Array;
  readonly flag: Uint8Array; // 1=EXACT 2=LOWER 3=UPPER
  readonly bestSuit: Int8Array; // 最佳着法花色, -1 = 无
  readonly bestRank: Int8Array; // 最佳着法点位序号

  constructor(sizeLog2 = DEFAULT_TT_LOG2) {
    this.size = 1 << sizeLog2;
    this.lo = new Uint32Array(this.size);
    this.hi = new Uint32Array(this.size);
    this.val = new Int8Array(this.size);
    this.flag = new Uint8Array(this.size);
    this.bestSuit = new Int8Array(this.size);
    this.bestRank = new Int8Array(this.size);
    this.bestSuit.fill(-1);
    this.bestRank.fill(-1);
  }

  clear(): void {
    this.lo.fill(0);
    this.hi.fill(0);
    this.val.fill(0);
    this.flag.fill(0);
    this.bestSuit.fill(-1);
    this.bestRank.fill(-1);
  }
}

// 确定性生成 4(家) x 4(花色) x 13(点位) 的双 32 位随机数
const ZOB: { lo: number; hi: number }[][][] = (() => {
  const rng = makeRng(0x9e3779b9);
  const z: { lo: number; hi: number }[][][] = [];
  for (let p = 0; p < 4; p++) {
    z.push([]);
    for (let s = 0; s < 4; s++) {
      z[p]!.push([]);
      for (let r = 0; r < 13; r++) {
        z[p]![s]!.push({
          lo: (rng() * 0x100000000) >>> 0,
          hi: (rng() * 0x100000000) >>> 0,
        });
      }
    }
  }
  return z;
})();

// 当前墩已出牌的独立 Zobrist 表 (与"手牌持有"区分, 避免墩中状态哈希碰撞)
const ZOB_PLAYED: { lo: number; hi: number }[][][] = (() => {
  const rng = makeRng(0x85ebca6b);
  const z: { lo: number; hi: number }[][][] = [];
  for (let p = 0; p < 4; p++) {
    z.push([]);
    for (let s = 0; s < 4; s++) {
      z[p]!.push([]);
      for (let r = 0; r < 13; r++) {
        z[p]![s]!.push({
          lo: (rng() * 0x100000000) >>> 0,
          hi: (rng() * 0x100000000) >>> 0,
        });
      }
    }
  }
  return z;
})();

export interface PlayedCard {
  seat: Seat;
  suit: Suit;
  rankIdx: number; // 0..12 (2..A)
}

interface MoveRecord {
  seat: Seat;
  suit: Suit;
  rankIdx: number;
  prevTurn: Seat;
  prevLeadSuit: Suit | null;
  prevPlayed: PlayedCard[]; // 出牌前的完整快照, 回退整体替换
  trickFinished: boolean;
  nsWon: boolean;
  hashLo: number;
  hashHi: number;
  prevRemaining: number;
}

export class DoubleDummySolver {
  private hands: Hands;
  private readonly trump: Suit | null;
  private hashLo = 0;
  private hashHi = 0;

  private played: PlayedCard[] = [];
  private leadSuit: Suit | null = null;
  private turn: Seat = 0;
  private remainingCards = 52;

  // 置换表 (键 + 值分离的扁平类型化数组), 可由外部注入以便跨求解复用
  private readonly tt: TranspositionTable;

  public stats: DDSStats = { nodes: 0, ttStores: 0, ttHits: 0 };

  constructor(hands: Hands, strain: Strain, tt?: TranspositionTable) {
    this.hands = hands.map((h) => h.slice());
    this.trump = strain === NT ? null : (strain as Suit);
    this.tt = tt ?? new TranspositionTable();
    for (let p = 0; p < 4; p++) {
      for (let s = 0; s < 4; s++) {
        let mask = this.hands[p]![s]!;
        while (mask) {
          const b = mask & -mask;
          const r = lowestBitIndex(b);
          const z = ZOB[p]![s]![r]!;
          this.hashLo = (this.hashLo ^ z.lo) >>> 0;
          this.hashHi = (this.hashHi ^ z.hi) >>> 0;
          mask ^= b;
        }
      }
    }
    this.remainingCards = 0;
    for (let p = 0; p < 4; p++) for (let s = 0; s < 4; s++) this.remainingCards += popcount(this.hands[p]![s]!);
  }

  /** 四家在某将牌下分别领出时, NS 能拿的墩数; 返回 [N领, E领, S领, W领] */
  static solveAllLeads(hands: Hands, strain: Strain): { tricksNS: Int8Array; stats: DDSStats } {
    const tt = new TranspositionTable();
    const solver = new DoubleDummySolver(hands, strain, tt);
    const tricksNS = new Int8Array(4);
    for (let leader = 0; leader < 4; leader++) {
      tricksNS[leader] = solver.solveFromTrickStart(leader as Seat);
    }
    return { tricksNS, stats: { ...solver.stats } };
  }

  /** 从一个墩首状态 (新的一墩, 由 leader 领出) 开始求解 NS 墩数 */
  solveFromTrickStart(leader: Seat): number {
    this.turn = leader;
    this.played = [];
    this.leadSuit = null;
    return this.search(0, 13);
  }

  /**
   * 复盘用的实例方法: 在给定残局上评估, 与本求解器共用置换表 (热缓存)。
   * 返回 NS 在剩余牌 (含当前墩) 中能拿到的墩数, 不含已落袋墩数。
   */
  evaluate(hands: Hands, playedSoFar: PlayedCard[], turn: Seat): number {
    const solver = new DoubleDummySolver(hands, this.trump === null ? NT : ((this.trump as number) as Strain), this.tt);
    solver.played = playedSoFar.map((c) => ({ ...c }));
    solver.leadSuit = playedSoFar.length > 0 ? playedSoFar[0]!.suit : null;
    solver.turn = turn;
    solver.foldPlayedHash();
    return solver.search(0, 13);
  }

  /** 把当前墩已出牌的 Zobrist 分量并入哈希 (用于带 playedSoFar 构造的残局) */
  private foldPlayedHash(): void {
    for (const c of this.played) {
      const zp = ZOB_PLAYED[c.seat]![c.suit]![c.rankIdx]!;
      this.hashLo = (this.hashLo ^ zp.lo) >>> 0;
      this.hashHi = (this.hashHi ^ zp.hi) >>> 0;
    }
  }

  /**
   * 复盘用: 在给定的部分残局上评估。
   * hands = 当前各家剩余牌; playedSoFar = 当前墩已出的牌 (按出牌顺序);
   * turn = 下一个出牌的座位; nsTricksBanked = 此前 NS 已落袋的墩数。
   * 返回 NS 最终总墩数 (含已落袋的)。
   */
  static evaluatePosition(
    hands: Hands,
    strain: Strain,
    playedSoFar: PlayedCard[],
    turn: Seat,
    nsTricksBanked: number,
    stats?: DDSStats,
  ): number {
    const solver = new DoubleDummySolver(hands, strain);
    solver.played = playedSoFar.map((c) => ({ ...c }));
    solver.leadSuit = playedSoFar.length > 0 ? playedSoFar[0]!.suit : null;
    solver.turn = turn;
    solver.foldPlayedHash();
    const st = stats ?? { nodes: 0, ttStores: 0, ttHits: 0 };
    const future = solver.searchWithStats(0, 13, st);
    return nsTricksBanked + future;
  }

  // ---------------------------------------------------------------- 搜索核心

  private search(alpha: number, beta: number): number {
    return this.searchWithStats(alpha, beta, this.stats);
  }

  private searchWithStats(alpha: number, beta: number, stats: DDSStats): number {
    stats.nodes++;

    if (this.remainingCards === 0 && this.played.length === 0) return 0;

    // 终局知识: 墩首且只剩 1 墩 (每家 1 张), 直接判定 NS 能否拿到这墩
    if (this.played.length === 0 && this.remainingCards === 4) {
      return this.lastTrickValue();
    }

    // 置换表只在墩首存取 (墩中状态重复率低, 全节点记忆化反而增加探测开销)
    if (this.played.length === 0) {
      const tt = this.ttLookup();
      let hint: { suit: Suit; rankIdx: number } | null = null;
      if (tt !== null) {
        stats.ttHits++;
        if (tt.bestSuit >= 0) hint = { suit: tt.bestSuit as Suit, rankIdx: tt.bestRank };
        if (tt.flag === 1) return tt.value;
        if (tt.flag === 2) {
          if (tt.value >= beta) return tt.value;
          alpha = Math.max(alpha, tt.value);
        } else if (tt.flag === 3) {
          if (tt.value <= alpha) return tt.value;
          beta = Math.min(beta, tt.value);
        }
      }

      const origAlpha = alpha;
      const result = this.searchMoves(alpha, beta, stats, hint);

      let flag = 1;
      if (result <= origAlpha) flag = 3;
      else if (result >= beta) flag = 2;
      this.ttStore(result, flag, this.lastBestMove);
      stats.ttStores++;
      return result;
    }

    return this.searchMoves(alpha, beta, stats, null);
  }

  private lastBestMove: { suit: Suit; rankIdx: number } | null = null;

  private searchMoves(
    alpha: number,
    beta: number,
    stats: DDSStats,
    hint: { suit: Suit; rankIdx: number } | null,
  ): number {
    const maximizing = sideOf(this.turn) === 0; // NS 行棋取 max
    const legalMasks = this.legalMasks();
    const groups = this.equivalenceGroups(legalMasks);
    const isLastToPlay = this.played.length === 3;
    const partnerWinning = isLastToPlay && this.currentWinnerSeat() === partnerSeat(this.turn);

    let best = maximizing ? -1 : 14;
    let localBest: { suit: Suit; rankIdx: number } | null = null;

    const consider = (rankIdx: number, suit: Suit): boolean => {
      const move = this.doMove(suit, rankIdx);
      // 若本墩在此结算且 NS 赢, 子搜索的坐标系比本节点少 1 墩,
      // 必须把窗口同步下移 1, 否则 alpha-beta 与置换表边界全部错位。
      const shift = move.trickFinished && move.nsWon ? 1 : 0;
      const childVal = this.searchWithStats(alpha - shift, beta - shift, stats);
      const val = childVal + shift;
      this.undoMove(move);

      if (maximizing) {
        if (val > best) {
          best = val;
          localBest = { suit, rankIdx };
        }
        if (val > alpha) alpha = val;
      } else {
        if (val < best) {
          best = val;
          localBest = { suit, rankIdx };
        }
        if (val < beta) beta = val;
      }
      return alpha >= beta;
    };

    // 生成代表性着法 (每个等价组一张), 再做着法排序
    interface Move {
      suit: Suit;
      rankIdx: number;
    }
    const moves: Move[] = [];
    for (const group of groups) {
      const { suit, mask } = group;
      if (partnerWinning) {
        // 同伴已赢墩且自己最后出: 该花色最小牌即可
        moves.push({ suit, rankIdx: lowestBitIndex(mask) });
        continue;
      }
      if (this.played.length === 0) {
        // 领出: 组内代表牌即最大牌
        moves.push({ suit, rankIdx: highestBitIndex(mask) });
      } else {
        // 跟牌: 组内代表牌即最小牌
        moves.push({ suit, rankIdx: lowestBitIndex(mask) });
      }
    }

    // 排序: TT 最佳着法最先; 跟牌再按赢墩能力 (能盖过当前赢家的最小赢牌优先)
    if (hint) {
      moves.sort((a, b) => {
        const ah = a.suit === hint.suit && a.rankIdx === hint.rankIdx ? 0 : 1;
        const bh = b.suit === hint.suit && b.rankIdx === hint.rankIdx ? 0 : 1;
        return ah - bh;
      });
    } else if (this.played.length > 0 && !partnerWinning) {
      const win = this.currentWinnerSeat();
      const winCard = this.played.find((c) => c.seat === win)!;
      const rankOf = (mv: Move): number => {
        if (mv.suit === winCard.suit) return mv.rankIdx > winCard.rankIdx ? mv.rankIdx : 99 + mv.rankIdx;
        if (this.trump !== null && mv.suit === this.trump && winCard.suit !== this.trump) return mv.rankIdx;
        return 99 + mv.rankIdx; // 垫牌排最后, 小牌优先
      };
      moves.sort((a, b) => rankOf(a) - rankOf(b));
    }

    for (const mv of moves) {
      if (consider(mv.rankIdx, mv.suit)) {
        this.lastBestMove = localBest;
        return best;
      }
    }

    this.lastBestMove = localBest;
    return best;
  }

  // ---------------------------------------------------------------- 着法生成

  private legalMasks(): number[] {
    const masks = [0, 0, 0, 0];
    const h = this.hands[this.turn]!;
    if (this.leadSuit !== null) {
      const led = h[this.leadSuit]!;
      if (led !== 0) {
        masks[this.leadSuit] = led;
        return masks;
      }
    }
    for (let s = 0; s < 4; s++) masks[s] = h[s]!;
    return masks;
  }

  /**
   * 等价牌分组 (保守且经穷举验证正确):
   * 领出时: 同花色相邻连张 (中间无别家持牌) 合并为代表牌。
   * 跟牌时: 除相邻连张外, 若整个花色都无法赢下当前墩 (既盖不过领出/当前赢家,
   *         也不是能将吃的将牌), 则该花色任意牌对本墩胜负等价, 整组只留最小牌;
   *         跨花色仍不等价 (垫哪门花色影响后续)。
   */
  private equivalenceGroups(legalMasks: number[]): { suit: Suit; mask: number }[] {
    const out: { suit: Suit; mask: number }[] = [];
    const following = this.played.length > 0;
    let winCard: PlayedCard | null = null;
    if (following) {
      const win = this.currentWinnerSeat();
      winCard = this.played.find((c) => c.seat === win)!;
    }
    const suitCannotWin = (suit: Suit, mask: number): boolean => {
      if (!winCard) return false;
      const top = highestBitIndex(mask);
      if (suit === winCard.suit) return top <= winCard.rankIdx; // 盖不过
      if (this.trump !== null && suit === this.trump && winCard.suit !== this.trump) return false; // 将吃能赢
      return true; // 旁套垫牌, 不可能赢
    };

    // 节点级一次性算出每个花色的全局剩余掩码, 各花色复用
    const outstandingBySuit = [0, 0, 0, 0];
    for (let p = 0; p < 4; p++) {
      for (let s = 0; s < 4; s++) outstandingBySuit[s]! |= this.hands[p]![s]!;
    }

    for (let s = 0; s < 4; s++) {
      const own = legalMasks[s]!;
      if (own === 0) continue;
      const suit = s as Suit;

      // 跟牌且该花色铁定赢不了: 整花色只出最小牌
      if (following && suitCannotWin(suit, own)) {
        out.push({ suit, mask: 1 << lowestBitIndex(own) });
        continue;
      }

      const outstanding = outstandingBySuit[s]!;

      let rest = own;
      while (rest) {
        const topIdx = highestBitIndex(rest);
        let groupMask = 1 << topIdx;
        let r = topIdx - 1;
        while (r >= 0 && (own & (1 << r)) && (outstanding & (1 << (r + 1)))) {
          groupMask |= 1 << r;
          r--;
        }
        out.push({ suit, mask: groupMask });
        rest &= ~groupMask;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 出牌/回退

  private doMove(suit: Suit, rankIdx: number): MoveRecord {
    const seat = this.turn;
    const prevTurn = seat;
    const prevLeadSuit = this.leadSuit;
    const prevPlayed = this.played; // 保存引用; 下方需要变更时才创建新数组
    const prevHashLo = this.hashLo;
    const prevHashHi = this.hashHi;
    const prevRemaining = this.remainingCards;

    this.hands[seat]![suit]! &= ~(1 << rankIdx);
    const z = ZOB[seat]![suit]![rankIdx]!;
    this.hashLo = (this.hashLo ^ z.lo) >>> 0;
    this.hashHi = (this.hashHi ^ z.hi) >>> 0;
    // 标记该牌进入当前墩
    const zp = ZOB_PLAYED[seat]![suit]![rankIdx]!;
    this.hashLo = (this.hashLo ^ zp.lo) >>> 0;
    this.hashHi = (this.hashHi ^ zp.hi) >>> 0;

    // 复制一份再追加, 绝不修改快照数组
    const nextPlayed = prevPlayed.concat({ seat, suit, rankIdx });
    this.remainingCards--;
    this.turn = nextSeat(seat);

    let trickFinished = false;
    let nsWon = false;
    if (nextPlayed.length === 4) {
      trickFinished = true;
      this.played = nextPlayed; // 让 currentWinnerSeat 能读到这 4 张
      const winner = this.currentWinnerSeat();
      nsWon = sideOf(winner) === 0;
      // 当前墩清空: 把这 4 张的"已出牌"哈希分量全部移除
      for (const c of nextPlayed) {
        const cz = ZOB_PLAYED[c.seat]![c.suit]![c.rankIdx]!;
        this.hashLo = (this.hashLo ^ cz.lo) >>> 0;
        this.hashHi = (this.hashHi ^ cz.hi) >>> 0;
      }
      this.played = [];
      this.leadSuit = null;
      this.turn = winner;
    } else {
      if (prevPlayed.length === 0) this.leadSuit = suit;
      this.played = nextPlayed;
    }

    return {
      seat,
      suit,
      rankIdx,
      prevTurn,
      prevLeadSuit,
      prevPlayed,
      trickFinished,
      nsWon,
      hashLo: prevHashLo,
      hashHi: prevHashHi,
      prevRemaining,
    };
  }

  private undoMove(m: MoveRecord): void {
    this.turn = m.prevTurn;
    this.leadSuit = m.prevLeadSuit;
    this.hashLo = m.hashLo;
    this.hashHi = m.hashHi;
    this.remainingCards = m.prevRemaining;
    this.hands[m.seat]![m.suit]! |= 1 << m.rankIdx;
    this.played = m.prevPlayed; // 整体恢复, 不做原地修改
  }

  // ---------------------------------------------------------------- 墩赢家

  /**
   * 终局知识: 墩首且每家恰剩 1 张。领出者 (this.turn) 只有一张牌可出,
   * 其余三家也各只有一张, 整墩唯一确定, 直接判 NS 是否赢这墩。
   */
  private lastTrickValue(): number {
    const leader = this.turn;
    const leaderHands = this.hands[leader]!;
    let leadSuit = -1;
    let leadRank = -1;
    for (let s = 0; s < 4; s++) {
      const mask = leaderHands[s]!;
      if (mask !== 0) {
        leadSuit = s;
        leadRank = highestBitIndex(mask);
        break;
      }
    }
    let winSeat = leader;
    let winSuit = leadSuit;
    let winRank = leadRank;
    for (let i = 1; i < 4; i++) {
      const seat = ((leader + i) & 3) as Seat;
      const h = this.hands[seat]!;
      // 该家唯一的牌
      let cardSuit = -1;
      let cardRank = -1;
      for (let s = 0; s < 4; s++) {
        if (h[s] !== 0) {
          cardSuit = s;
          cardRank = highestBitIndex(h[s]!);
          break;
        }
      }
      const beats =
        cardSuit === winSuit
          ? cardRank > winRank
          : this.trump !== null && cardSuit === this.trump && winSuit !== this.trump;
      if (beats) {
        winSeat = seat;
        winSuit = cardSuit;
        winRank = cardRank;
      }
    }
    return sideOf(winSeat) === 0 ? 1 : 0;
  }

  /** 当前墩 (played 中 1..4 张) 暂时的赢家座位 */
  private currentWinnerSeat(): Seat {
    let winner = this.played[0]!.seat;
    let winRank = this.played[0]!.rankIdx;
    let winSuit = this.played[0]!.suit;
    for (let i = 1; i < this.played.length; i++) {
      const c = this.played[i]!;
      const beats =
        c.suit === winSuit
          ? c.rankIdx > winRank
          : this.trump !== null && c.suit === this.trump && winSuit !== this.trump;
      if (beats) {
        winner = c.seat;
        winRank = c.rankIdx;
        winSuit = c.suit;
      }
    }
    return winner;
  }

  // ---------------------------------------------------------------- 置换表

  private ttIndex(): number {
    const leadMix = this.leadSuit === null ? 0 : (this.leadSuit + 1) * 0x85ebca6b;
    const lenMix = this.played.length * 0xc2b2ae35;
    return (this.hashLo ^ (this.hashHi >>> 7) ^ (this.turn * 0x9e3779b9) ^ leadMix ^ lenMix) & (this.tt.size - 1);
  }

  private ttLookup(): { value: number; flag: number; bestSuit: number; bestRank: number } | null {
    let idx = this.ttIndex();
    for (let probe = 0; probe < MAX_PROBES; probe++) {
      const lo = this.tt.lo[idx]!;
      if (lo === EMPTY_LO) return null;
      if (lo === this.hashLo && this.tt.hi[idx] === this.hashHi) {
        return {
          value: this.tt.val[idx]!,
          flag: this.tt.flag[idx]!,
          bestSuit: this.tt.bestSuit[idx]!,
          bestRank: this.tt.bestRank[idx]!,
        };
      }
      idx = (idx + 1) & (this.tt.size - 1);
    }
    return null;
  }

  private ttStore(value: number, flag: number, best: { suit: Suit; rankIdx: number } | null): void {
    let idx = this.ttIndex();
    let slot = -1;
    for (let probe = 0; probe < MAX_PROBES; probe++) {
      const lo = this.tt.lo[idx]!;
      if (lo === EMPTY_LO) {
        if (slot < 0) slot = idx;
        break;
      }
      if (lo === this.hashLo && this.tt.hi[idx] === this.hashHi) {
        slot = idx;
        break;
      }
      if (slot < 0) slot = idx;
      idx = (idx + 1) & (this.tt.size - 1);
    }
    if (slot < 0) return;
    this.tt.lo[slot] = this.hashLo;
    this.tt.hi[slot] = this.hashHi;
    this.tt.val[slot] = value;
    this.tt.flag[slot] = flag;
    this.tt.bestSuit[slot] = best ? best.suit : -1;
    this.tt.bestRank[slot] = best ? best.rankIdx : -1;
  }
}
