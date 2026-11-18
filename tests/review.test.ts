import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewEngine } from '../src/review/review.js';
import { emptyHand } from '../src/deal.js';
import type { Deal } from '../src/deal.js';
import type { Seat } from '../src/cards.js';
import { NT } from '../src/cards.js';

/** 构造每手 keep 张的残局（确定性发牌） */
function makeDeal(spec: Array<Record<number, number[]>>): Deal {
  const deal: Deal = [emptyHand(), emptyHand(), emptyHand(), emptyHand()];
  spec.forEach((suits, seat) => {
    for (const [suit, ranks] of Object.entries(suits)) {
      for (const rank of ranks!) {
        deal[seat as Seat]![Number(suit)]! |= 1 << (rank - 2);
      }
    }
  });
  return deal;
}

test('复盘：一墩定胜负，A 最大时首引 A 是唯一最佳且 0 丢墩', () => {
  // 全黑桃(suit=3)：N=A(14) E=K(13) S=Q(12) W=2，NT，N 首引
  const deal = makeDeal([
    { 3: [14] }, { 3: [13] }, { 3: [12] }, { 3: [2] },
  ]);
  const review = new ReviewEngine(deal, NT, 0);
  const evals = review.evaluateLegalMoves();
  assert.equal(evals.length, 1);
  assert.equal(evals[0]!.isBest, true);
  assert.equal(evals[0]!.tricksLost, 0);
  assert.equal(evals[0]!.nsTricksAfter, 1); // NS 赢这墩
});

test('复盘：出完整墩后赢家领出下一墩，nsTricks 正确累计', () => {
  // 两墩，全黑桃
  const deal = makeDeal([
    { 3: [14, 2] }, { 3: [13, 3] }, { 3: [12, 4] }, { 3: [11, 5] },
  ]);
  const review = new ReviewEngine(deal, NT, 0);
  // 打完第一墩（N 领 A，最大，N 赢）
  review.play(3 * 13 + (14 - 2)); // N 的 A
  review.play(3 * 13 + (13 - 2)); // E 的 K
  review.play(3 * 13 + (12 - 2)); // S 的 Q
  review.play(3 * 13 + (11 - 2)); // W 的 J
  const st = review.state;
  assert.equal(st.nsTricks, 1);
  assert.equal(st.completedTricks.length, 1);
  assert.equal(st.current, 0); // N 赢墩，继续领出
  assert.equal(st.currentTrick.length, 0);
  assert.equal(st.cardsLeft, 4);
});

test('复盘：非法跟牌（有同花色却出别的）抛错', () => {
  const deal = makeDeal([
    { 3: [14], 2: [2] }, { 3: [13] }, { 3: [12] }, { 3: [11] },
  ]);
  const review = new ReviewEngine(deal, NT, 0);
  review.play(3 * 13 + (14 - 2)); // N 领黑桃 A
  // E 有黑桃 K，必须跟黑桃
  assert.throws(() => review.play(0)); // card 0 = 草花 2，非法
});

test('复盘：52 张完整牌局能逐墩打到结束，最终 NS+EW=13', () => {
  // 用简单的均匀发牌
  const deal: Deal = [emptyHand(), emptyHand(), emptyHand(), emptyHand()];
  for (let card = 0; card < 52; card++) {
    const seat = (card % 4) as Seat;
    const suit = Math.floor(card / 13) as 0 | 1 | 2 | 3;
    const rank = (card % 13) + 2;
    deal[seat]![suit]! |= 1 << (rank - 2);
  }
  const review = new ReviewEngine(deal, NT, 0);
  let guard = 0;
  while (!review.isDone && guard++ < 60) {
    const moves = review.legalMoves();
    assert.ok(moves.length > 0);
    review.play(moves[0]!); // 总是出第一张合法牌
  }
  assert.equal(review.isDone, true);
  assert.equal(review.state.completedTricks.length, 13);
  // EW 墩 = 13 - NS 墩
  assert.ok(review.state.nsTricks >= 0 && review.state.nsTricks <= 13);
});

test('复盘：最佳出法至少有一张，且所有评估的丢墩数非负', () => {
  const deal = makeDeal([
    { 3: [14, 13], 2: [2] }, { 3: [12], 2: [3] }, { 3: [11], 2: [4] }, { 3: [10], 2: [5] },
  ]);
  const review = new ReviewEngine(deal, NT, 0);
  const evals = review.evaluateLegalMoves();
  assert.ok(evals.some((e) => e.isBest));
  assert.ok(evals.every((e) => e.tricksLost >= 0));
});
