import { test, expect } from 'vitest';
import { DoubleDummySolver, TranspositionTable } from '../src/engine/dds.ts';
import { dealReducedHands } from '../src/engine/deal.ts';
import { dealRandomHands, makeRng } from '../src/engine/cards.ts';

// 快速基准: 小残局节点数与吞吐, 常规测试可运行
test('benchmark k=9 reduced deal', () => {
  const hands = dealReducedHands(9, 777);
  const tt = new TranspositionTable(22);
  const t0 = Date.now();
  const s = new DoubleDummySolver(hands, 3, tt);
  const v = s.solveFromTrickStart(0);
  const ms = Date.now() - t0;
  const nps = Math.round(s.stats.nodes / Math.max(1, ms / 1000));
  console.log(`k=9 ms=${ms} nodes=${s.stats.nodes} nps=${nps} v=${v}`);
  expect(v).toBeGreaterThanOrEqual(0);
  expect(v).toBeLessThanOrEqual(9);
});

// 全 13 张端到端基准: 纯 TS 引擎耗时较长, 默认跳过; 手动开启用于性能回归
test.skip('benchmark full 13-card single leader', () => {
  const hands = dealRandomHands(makeRng(5));
  const tt = new TranspositionTable(22);
  const t0 = Date.now();
  const s = new DoubleDummySolver(hands, 3, tt);
  const v = s.solveFromTrickStart(0);
  console.log(`FULL ms=${Date.now() - t0} nodes=${s.stats.nodes} v=${v}`);
  expect(v).toBeGreaterThanOrEqual(0);
});
