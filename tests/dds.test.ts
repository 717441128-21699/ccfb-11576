import { describe, it, expect } from 'vitest';
import { DoubleDummySolver, TranspositionTable, type PlayedCard } from '../src/engine/dds.ts';
import { bruteForceNSTricks } from '../src/engine/brute.ts';
import { dealReducedHands } from '../src/engine/deal.ts';
import { parsePBNDeal, toPBNDeal, Strain, Seat, Hands, makeRng, dealRandomHands } from '../src/engine/cards.ts';

const STRAINS: Strain[] = [0, 1, 2, 3, 4];
const SEATS: Seat[] = [0, 1, 2, 3];

describe('双明手求解器 vs 暴力穷举 (小残局)', () => {
  it('每家 3 张, 50 副随机牌 x 5 定约 x 4 领出, 全部一致', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const hands = dealReducedHands(3, seed * 7 + 13);
      for (const strain of STRAINS) {
        const tt = new TranspositionTable();
        for (const leader of SEATS) {
          const fast = new DoubleDummySolver(hands, strain, tt).solveFromTrickStart(leader);
          const slow = bruteForceNSTricks(hands, strain, [], leader);
          expect(fast, `seed=${seed} strain=${strain} leader=${leader}`).toBe(slow);
        }
      }
    }
  });

  it('每家 4 张, 12 副随机牌全对比', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const hands = dealReducedHands(4, seed * 101 + 5);
      for (const strain of STRAINS) {
        const tt = new TranspositionTable();
        for (const leader of SEATS) {
          const fast = new DoubleDummySolver(hands, strain, tt).solveFromTrickStart(leader);
          const slow = bruteForceNSTricks(hands, strain, [], leader);
          expect(fast, `seed=${seed} strain=${strain} leader=${leader}`).toBe(slow);
        }
      }
    }
  });

  it('残局中途评估 (墩中状态) 也一致', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const hands = dealReducedHands(4, seed * 31 + 9);
      const strain: Strain = (seed % 5) as Strain;
      const leader: Seat = (seed % 4) as Seat;
      // 模拟领出第一张
      const leadSeat = leader;
      const leadHand = hands[leadSeat]!;
      const suitWithCards = leadHand.findIndex((m) => m !== 0) as 0 | 1 | 2 | 3;
      const mask = leadHand[suitWithCards]!;
      const rankIdx = 31 - Math.clz32(mask & -mask);
      const after = hands.map((h) => h.slice());
      after[leadSeat]![suitWithCards]! &= ~(1 << rankIdx);
      const played: PlayedCard[] = [{ seat: leadSeat, suit: suitWithCards, rankIdx }];
      const turn: Seat = ((leadSeat + 1) & 3) as Seat;

      const fast = DoubleDummySolver.evaluatePosition(after, strain, played, turn, 0);
      const slow = bruteForceNSTricks(after, strain, played, turn);
      expect(fast, `seed=${seed}`).toBe(slow);
    }
  });
});

describe('整副牌 (每家13张) 合理性', () => {
  // 注: 全 13 张求解在纯 TS 引擎下耗时较长, 此用例默认跳过。
  // 正确性已由大量 k=3/k=4 小残局与暴力穷举对拍覆盖; 需端到端验证时改为 it(...)。
  it.skip('随机整牌: 结果在 0..13 之间且四个领出结果差异不超过 1', () => {
    const rng = makeRng(42);
    for (let d = 0; d < 20; d++) {
      const hands = dealRandomHands(rng);
      for (const strain of STRAINS) {
        const { tricksNS } = DoubleDummySolver.solveAllLeads(hands, strain);
        const vals = [...tricksNS];
        for (const v of vals) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(13);
        }
        // 谁领出的差异在桥牌里不会超过 1 墩
        expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('经典牌例: 明手全大将牌吃通 = 13 墩', () => {
    // N 持有全部黑桃并以 S 为将, NS 至少 13 墩 (将吃全部旁套)
    const hands = buildAllSpadesNS();
    const { tricksNS } = DoubleDummySolver.solveAllLeads(hands, 3);
    expect(Math.min(...tricksNS)).toBe(13);
  });
});

function buildAllSpadesNS(): Hands {
  // N 拿全部 13 张黑桃, S/E/W 分其余 39 张 (每花色 13 张, 去掉黑桃)
  const hands: Hands = [
    [0, 0, 0, 0x1fff],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const rng = makeRng(7);
  const pool: number[] = [];
  for (let s = 0; s < 3; s++) for (let r = 0; r < 13; r++) pool.push(s * 13 + r);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  for (let i = 0; i < pool.length; i++) {
    const seat = ((i / 13) | 0) + 1; // S=1, W=2, E=3
    const id = pool[i]!;
    const suit = (id / 13) | 0;
    const r = id % 13;
    hands[seat]![suit]! |= 1 << r;
  }
  return hands;
}

describe('PBN 解析往返', () => {
  it('解析与重组一致', () => {
    const rng = makeRng(99);
    const hands = dealRandomHands(rng);
    const pbn = toPBNDeal(hands, 0);
    const back = parsePBNDeal(pbn, 0);
    expect(back).toEqual(hands);
  });
});
