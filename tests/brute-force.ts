import {
  type Seat,
  type Suit,
  type Trump,
  NT,
  nextSeat,
  seatSide,
} from '../src/cards.js';
import type { Deal } from '../src/deal.js';
import { bitCount } from '../src/deal.js';

/**
 * 独立的朴素 Minimax（无任何剪枝、无哈希），只用于测试对拍。
 * 牌的表示刻意换一种风格：直接用 {suit, rank} 对象数组，
 * 与被测引擎的位掩码实现完全独立，避免同源错误。
 */

interface CardObj {
  suit: Suit;
  rank: number;
}

function legalMoves(
  deal: Deal,
  current: Seat,
  leadSuit: Suit | 4,
): CardObj[] {
  const hand = deal[current]!;
  const moves: CardObj[] = [];
  if (leadSuit !== 4 && hand[leadSuit] !== 0) {
    let mask = hand[leadSuit]!;
    while (mask) {
      const bit = mask & -mask;
      moves.push({ suit: leadSuit, rank: 32 - Math.clz32(bit) + 1 });
      mask ^= bit;
    }
    return moves;
  }
  for (let suit = 0; suit < 4; suit++) {
    let mask = hand[suit]!;
    while (mask) {
      const bit = mask & -mask;
      moves.push({ suit: suit as Suit, rank: 32 - Math.clz32(bit) + 1 });
      mask ^= bit;
    }
  }
  return moves;
}

function beats(
  trump: Trump,
  c: CardObj,
  winSuit: Suit | 4,
  winRank: number,
): boolean {
  if (c.suit === winSuit) return c.rank > winRank;
  return trump !== NT && c.suit === trump && winSuit !== trump;
}

/**
 * 朴素递归：返回从当前局面起 NS 能拿到的总墩数（含已入账的 nsTricks）。
 * 仅适用于小残局（建议每手 ≤ 4 张），否则组合爆炸。
 */
export function bruteForceNsTricks(
  deal: Deal,
  trump: Trump,
  leader: Seat,
): number {
  const work: Deal = deal.map((h) => [...h]) as Deal;

  function rec(
    current: Seat,
    leadSuit: Suit | 4,
    winSuit: Suit | 4,
    winRank: number,
    winSeat: Seat,
    nsTricks: number,
    cardsLeft: number,
  ): number {
    if (cardsLeft === 0) return nsTricks;
    const moves = legalMoves(work, current, leadSuit);
    const isMax = seatSide(current) === 0;
    let best = isMax ? -1 : 14;

    for (const move of moves) {
      const bit = 1 << (move.rank - 2);
      work[current]![move.suit]! &= ~bit;
      const next = nextSeat(current);
      const playedInTrick = (4 - (cardsLeft % 4)) % 4;
      let v: number;

      if (playedInTrick === 0) {
        v = rec(next, move.suit, move.suit, move.rank, current, nsTricks, cardsLeft - 1);
      } else {
        let ns = winSeat;
        let nr = winRank;
        let nsu = winSuit;
        if (beats(trump, move, nsu, nr)) {
          ns = current;
          nr = move.rank;
          nsu = move.suit;
        }
        if (playedInTrick === 3) {
          const gained = seatSide(ns) === 0 ? 1 : 0;
          v = cardsLeft - 1 === 0
            ? nsTricks + gained
            : rec(ns, 4, 4, 0, ns, nsTricks + gained, cardsLeft - 1);
        } else {
          v = rec(next, leadSuit, nsu, nr, ns, nsTricks, cardsLeft - 1);
        }
      }

      work[current]![move.suit]! |= bit;
      if (isMax) {
        if (v > best) best = v;
      } else if (v < best) best = v;
    }
    return best;
  }

  const total = work.reduce(
    (n, h) => n + h.reduce((m, mask) => m + bitCount(mask), 0),
    0,
  );
  return rec(leader, 4, 4, 0, leader, 0, total);
}
