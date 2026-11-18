import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePBNDeal,
  toPBNDeal,
  rotateDeal,
  swapSuits,
  dealCardCount,
  emptyHand,
} from '../src/deal.js';
import { NT, SEATS, type Seat, type Trump, nextSeat } from '../src/cards.js';
import { DDSolver, tricksForDeclarer } from '../src/dds/solver.js';
import { bruteForceNsTricks } from './brute-force.js';
import { mulberry32, shuffled } from '../src/rng.js';
import type { Deal } from '../src/deal.js';

/** 生成可复现的随机完整牌局 */
function randomDeal(seed: number): Deal {
  const rng = mulberry32(seed);
  const cards = shuffled(rng, Array.from({ length: 52 }, (_, i) => i));
  const deal: Deal = [emptyHand(), emptyHand(), emptyHand(), emptyHand()];
  cards.forEach((card, i) => {
    const seat = (i % 4) as Seat;
    const suit = Math.floor(card / 13) as 0 | 1 | 2 | 3;
    const rank = (card % 13) + 2;
    deal[seat]![suit]! |= 1 << (rank - 2);
  });
  return deal;
}

/** 随机残局：每手保留 keep 张（四手张数相同，为 4 的倍数） */
function randomEndgame(seed: number, keep: number): Deal {
  const full = randomDeal(seed);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const out: Deal = [emptyHand(), emptyHand(), emptyHand(), emptyHand()];
  for (const seat of SEATS) {
    const all: number[] = [];
    for (let suit = 0; suit < 4; suit++) {
      let mask = full[seat]![suit]!;
      while (mask) {
        const bit = mask & -mask;
        all.push((suit << 4) | (32 - Math.clz32(bit) + 1));
        mask ^= bit;
      }
    }
    shuffled(rng, all);
    for (let i = 0; i < keep; i++) {
      const code = all[i]!;
      const suit = (code >> 4) as 0 | 1 | 2 | 3;
      const rank = code & 15;
      out[seat]![suit]! |= 1 << (rank - 2);
    }
  }
  return out;
}

test('PBN 解析与回转：52 张齐全、输出可再解析且等价', () => {
  const deal = randomDeal(20240517);
  assert.equal(dealCardCount(deal), 52);
  const text = toPBNDeal(deal);
  assert.deepEqual(parsePBNDeal(text), deal);
});

test('PBN 解析：带显式座位前缀与空白容错', () => {
  const deal = randomDeal(777);
  const text = toPBNDeal(deal).replace('N:', 'N: ');
  assert.deepEqual(parsePBNDeal(text), deal);
});

test('PBN 非法输入报错', () => {
  assert.throws(() => parsePBNDeal('N:AK.2.3.4 5.6.7.8 9.T.J.Q K.A.2.3'));
  assert.throws(() => parsePBNDeal('N:AKQ 5.6.7 8.9.T J.Q.K 2.3.4'));
});

test('小残局（每手 2 张）与暴力穷举一致：全部将牌 × 首引人', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const deal = randomEndgame(seed * 7 + 1, 2);
    for (let trump = 0; trump <= 4; trump++) {
      for (const leader of SEATS) {
        const got = new DDSolver(deal).solve(trump as Trump, leader).nsTricks;
        const want = bruteForceNsTricks(deal, trump as Trump, leader);
        assert.equal(got, want, `seed=${seed} trump=${trump} leader=${leader}`);
      }
    }
  }
});

test('中等残局（每手 3 张）与暴力穷举一致', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const deal = randomEndgame(seed * 13 + 5, 3);
    for (let trump = 0; trump <= 4; trump++) {
      for (const leader of [0, 2] as Seat[]) {
        const got = new DDSolver(deal).solve(trump as Trump, leader).nsTricks;
        const want = bruteForceNsTricks(deal, trump as Trump, leader);
        assert.equal(got, want, `seed=${seed} trump=${trump} leader=${leader}`);
      }
    }
  }
});

test('残局结果落在合法区间，且旋转 2 位（对家互换）后 NS 墩数不变', () => {
  const keep = 3;
  for (let seed = 1; seed <= 4; seed++) {
    const deal = randomEndgame(seed * 101, keep);
    const rot2 = rotateDeal(deal, 2); // N<->S、E<->W，NS 对仍是 NS 对
    for (let trump = 0; trump <= 4; trump++) {
      for (const leader of SEATS) {
        const nsTricks = new DDSolver(deal).solve(trump as Trump, leader).nsTricks;
        assert.ok(nsTricks >= 0 && nsTricks <= keep);
        const rotLeader = ((leader + 2) & 3) as Seat;
        const rotated = new DDSolver(rot2).solve(trump as Trump, rotLeader).nsTricks;
        assert.equal(nsTricks, rotated);
      }
    }
  }
});

test('不变量：整桌旋转 2 位（对家互换）后，NS 墩数保持不变', () => {
  const deal = randomEndgame(4242, 3);
  const rotated = rotateDeal(deal, 2);
  for (let trump = 0; trump <= 4; trump++) {
    for (const leader of SEATS) {
      const a = new DDSolver(deal).solve(trump as Trump, leader).nsTricks;
      const rotLeader = ((leader + 2) & 3) as Seat;
      const b = new DDSolver(rotated).solve(trump as Trump, rotLeader).nsTricks;
      assert.equal(a, b);
    }
  }
});

test('不变量：交换两个花色后，有将结果按映射保持、无将不变（残局）', () => {
  const deal = randomEndgame(7777, 3);
  const swapped = swapSuits(deal, 0, 1);
  for (const leader of [0, 1] as Seat[]) {
    assert.equal(
      new DDSolver(swapped).solve(NT, leader).nsTricks,
      new DDSolver(deal).solve(NT, leader).nsTricks,
    );
    assert.equal(
      new DDSolver(swapped).solve(0, leader).nsTricks,
      new DDSolver(deal).solve(1, leader).nsTricks,
    );
  }
});

test('tricksForDeclarer：按庄家下家首引取数，EW 坐庄取 13 互补', () => {
  // 用一张构造的 DDT 验证纯映射逻辑（完整牌局语义，总墩数 13）
  const table: number[][] = [
    [7, 5, 7, 5], [8, 4, 8, 4], [6, 6, 6, 6],
    [9, 3, 9, 3], [7, 5, 7, 5],
  ];
  // N 坐庄 -> E(1) 首引 -> table[trump][1]
  assert.equal(tricksForDeclarer(table, 0, 0), 5);
  // E 坐庄 -> S(2) 首引 -> table[0][2]=7（NS 墩），EW = 13-7 = 6
  assert.equal(tricksForDeclarer(table, 0, 1), 6);
  // S 坐庄 -> W(3) 首引 -> table[0][3]=5
  assert.equal(tricksForDeclarer(table, 0, 2), 5);
  // W 坐庄 -> N(0) 首引 -> table[0][0]=7，EW = 13-7 = 6
  assert.equal(tricksForDeclarer(table, 0, 3), 6);
});

test('确定性：同一残局重复求解结果一致', () => {
  const deal = randomEndgame(31337, 3);
  const a = new DDSolver(deal).solve(NT, 0).nsTricks;
  const b = new DDSolver(deal).solve(NT, 0).nsTricks;
  assert.equal(a, b);
});

test('置换表跨问题共享：复用表与新求解器答案一致且有命中', () => {
  const deal = randomEndgame(555, 3);
  const shared = new DDSolver(deal);
  for (let trump = 0; trump <= 4; trump++) {
    for (const leader of SEATS) {
      const a = shared.solve(trump as Trump, leader).nsTricks;
      const b = new DDSolver(deal).solve(trump as Trump, leader).nsTricks;
      assert.equal(a, b);
    }
  }
  assert.ok(shared.transpositionTable.stats().hitRate > 0);
});

test('首引座位按顺时针推进的约定自洽', () => {
  const deal = randomEndgame(123, 3);
  // 庄家下家首引：N 坐庄首引 E(1)，S 坐庄首引 W(3)
  assert.equal(nextSeat(0), 1);
  assert.equal(nextSeat(2), 3);
  // 不同首引人都能给出合法墩数
  for (const leader of SEATS) {
    const v = new DDSolver(deal).solve(0, leader).nsTricks;
    assert.ok(v >= 0 && v <= 3);
  }
});
