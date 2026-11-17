/**
 * 复盘 Worker: 在后台执行单步着法评估数组 (ReviewEngine.assess 的等价计算),
 * 避免在主线程触发 DDS 导致界面卡顿。同一 strain 复用热置换表。
 */

import { Hands, Seat, Strain, Suit, nextSeat, sideOf, popcount, lowestBitIndex } from '../engine/cards.ts';
import { DoubleDummySolver, TranspositionTable, type PlayedCard } from '../engine/dds.ts';

export interface AssessJob {
  kind: 'assess';
  id: number;
  hands: Hands;
  strain: Strain;
  currentTrick: PlayedCard[];
  turn: Seat;
  nsBanked: number;
  ewBanked: number;
}

export interface AssessMove {
  suit: Suit;
  rankIdx: number;
  sideTricks: number;
  isBest: boolean;
  loss: number;
}

export interface AssessResult {
  kind: 'assess';
  id: number;
  moves: AssessMove[];
  nsBanked: number;
  ewBanked: number;
  finished: boolean;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
// 每个 strain 一个持久 TT, 随复盘推进越来越热
const ttByStrain = new Map<Strain, TranspositionTable>();

function legalMasks(hands: Hands, turn: Seat, leadSuit: Suit | null): number[] {
  const masks = [0, 0, 0, 0];
  const h = hands[turn]!;
  if (leadSuit !== null && h[leadSuit] !== 0) {
    masks[leadSuit] = h[leadSuit]!;
    return masks;
  }
  for (let s = 0; s < 4; s++) masks[s] = h[s]!;
  return masks;
}

ctx.onmessage = (ev: MessageEvent<AssessJob>) => {
  const msg = ev.data;
  if (msg.kind !== 'assess') return;

  let tt = ttByStrain.get(msg.strain);
  if (!tt) {
    tt = new TranspositionTable(22);
    ttByStrain.set(msg.strain, tt);
  }

  const remaining = msg.hands.reduce((n, hh) => n + hh.reduce((m, x) => m + popcount(x), 0), 0);
  const finished = remaining === 0 && msg.currentTrick.length === 0;
  const moves: AssessMove[] = [];

  if (!finished) {
    const leadSuit = msg.currentTrick.length > 0 ? msg.currentTrick[0]!.suit : null;
    const masks = legalMasks(msg.hands, msg.turn, leadSuit);
    const moveSide = sideOf(msg.turn);

    for (let s = 0; s < 4; s++) {
      let m = masks[s]!;
      while (m) {
        const b = m & -m;
        m ^= b;
        const rankIdx = lowestBitIndex(b);

        // 模拟出牌
        const simHands = msg.hands.map((h) => h.slice());
        simHands[msg.turn]![s]! &= ~b;
        const simTrick = msg.currentTrick.map((c) => ({ ...c }));
        simTrick.push({ seat: msg.turn, suit: s as Suit, rankIdx });
        let nsBanked = msg.nsBanked;
        let ewBanked = msg.ewBanked;
        let nextTurn: Seat = nextSeat(msg.turn);
        let trick: PlayedCard[] = simTrick;
        if (simTrick.length === 4) {
          // 判墩
          const trump = msg.strain === 4 ? null : (msg.strain as Suit);
          let win = simTrick[0]!;
          for (let i = 1; i < 4; i++) {
            const c = simTrick[i]!;
            const beats =
              c.suit === win.suit ? c.rankIdx > win.rankIdx : trump !== null && c.suit === trump && win.suit !== trump;
            if (beats) win = c;
          }
          if (sideOf(win.seat) === 0) nsBanked++;
          else ewBanked++;
          nextTurn = win.seat;
          trick = [];
        }

        const solver = new DoubleDummySolver(simHands, msg.strain, tt);
        const rem = simHands.reduce((n, hh) => n + hh.reduce((mm, x) => mm + popcount(x), 0), 0);
        let futureNS = 0;
        if (rem > 0) futureNS = solver.evaluate(simHands, trick, nextTurn);
        const totalNS = nsBanked + futureNS;
        const sideTricks = moveSide === 0 ? totalNS : 13 - totalNS;
        moves.push({ suit: s as Suit, rankIdx, sideTricks, isBest: false, loss: 0 });
      }
    }

    const best = Math.max(...moves.map((x) => x.sideTricks));
    for (const x of moves) {
      x.isBest = x.sideTricks === best;
      x.loss = best - x.sideTricks;
    }
  }

  const res: AssessResult = {
    kind: 'assess',
    id: msg.id,
    moves,
    nsBanked: msg.nsBanked,
    ewBanked: msg.ewBanked,
    finished,
  };
  ctx.postMessage(res);
};
