/**
 * 暴力穷举参考求解器 (仅用于测试对拍):
 * 不带任何剪枝/置换表, 完整枚举所有合法出牌序列的极小极大。
 * 用整盘快照回退, 逻辑尽量直白; 只在每家 k 张牌的小型残局上运行。
 */

import { Hands, Seat, Strain, Suit, NT, nextSeat, sideOf, popcount, lowestBitIndex } from './cards.ts';
import type { PlayedCard } from './dds.ts';

export function bruteForceNSTricks(
  handsIn: Hands,
  strain: Strain,
  playedIn: PlayedCard[] = [],
  turnIn: Seat = 0,
): number {
  const hands = handsIn.map((h) => h.slice());
  let played = playedIn.map((c) => ({ ...c }));
  let turn = turnIn;
  const trump: Suit | null = strain === NT ? null : (strain as Suit);

  const totalRemaining = hands.reduce((n, h) => n + h.reduce((m, msk) => m + popcount(msk), 0), 0);
  // 牌已打光且当前没有未结算的墩: 终局
  if (totalRemaining === 0) {
    // played 理论上必为空 (墩满 4 张时在调用方已结算并递归传 []);
    // 若残留 4 张, 在此补结算以保证健壮性。
    if (played.length === 4) {
      let win = played[0]!;
      for (let i = 1; i < 4; i++) {
        const c = played[i]!;
        const beats =
          c.suit === win.suit
            ? c.rankIdx > win.rankIdx
            : trump !== null && c.suit === trump && win.suit !== trump;
        if (beats) win = c;
      }
      return sideOf(win.seat) === 0 ? 1 : 0;
    }
    return 0;
  }

  const leadSuit = played.length > 0 ? played[0]!.suit : null;
  const h = hands[turn]!;
  const legal: { suit: Suit; rankIdx: number }[] = [];

  const pushMask = (mask: number, suit: Suit): void => {
    let m = mask;
    while (m) {
      const b = m & -m;
      m ^= b;
      legal.push({ suit, rankIdx: lowestBitIndex(b) });
    }
  };

  if (leadSuit !== null && h[leadSuit] !== 0) {
    pushMask(h[leadSuit]!, leadSuit);
  } else {
    for (let s = 0; s < 4; s++) pushMask(h[s]!, s as Suit);
  }

  const maximizing = sideOf(turn) === 0;
  let best = maximizing ? -1 : 99;

  for (const move of legal) {
    // 快照
    const snapHands = hands.map((x) => x.slice());
    const snapPlayed = played.map((c) => ({ ...c }));
    const snapTurn = turn;

    hands[turn]![move.suit]! &= ~(1 << move.rankIdx);
    played.push({ seat: turn, suit: move.suit, rankIdx: move.rankIdx });
    let bonus = 0;

    if (played.length === 4) {
      let win = played[0]!;
      for (let i = 1; i < 4; i++) {
        const c = played[i]!;
        const beats =
          c.suit === win.suit
            ? c.rankIdx > win.rankIdx
            : trump !== null && c.suit === trump && win.suit !== trump;
        if (beats) win = c;
      }
      bonus = sideOf(win.seat) === 0 ? 1 : 0;
      turn = win.seat;
      played = [];
    } else {
      turn = nextSeat(turn);
    }

    const val = bonus + bruteForceNSTricks(hands, strain, played, turn);
    if (maximizing) {
      if (val > best) best = val;
    } else if (val < best) best = val;

    // 回退
    for (let p = 0; p < 4; p++) hands[p] = snapHands[p]!;
    played = snapPlayed;
    turn = snapTurn;
  }

  return best;
}
