/**
 * 小型残局发牌: 每家 k 张牌 (k <= 13), 每花色总数随意, 确定性随机。
 * 供求解器对拍使用。
 */

import { Hands, Suit, makeEmptyHands, makeRng, popcount } from './cards.ts';

export function dealReducedHands(k: number, seed: number): Hands {
  const rng = makeRng(seed);
  const total = k * 4;
  const deck: number[] = [];
  // 每个花色至少在牌堆里放若干张, 保证各花色都有机会出现
  const pool: number[] = [];
  for (let id = 0; id < 52; id++) pool.push(id);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  for (let i = 0; i < total; i++) deck.push(pool[i]!);

  const hands = makeEmptyHands();
  for (let i = 0; i < total; i++) {
    const seat = (i / k) | 0;
    const id = deck[i]!;
    const suit = ((id / 13) | 0) as Suit;
    const rankIdx = id % 13;
    hands[seat]![suit]! |= 1 << rankIdx;
  }
  return hands;
}

export function totalCards(hands: Hands): number {
  let n = 0;
  for (let p = 0; p < 4; p++) for (let s = 0; s < 4; s++) n += popcount(hands[p]![s]!);
  return n;
}
