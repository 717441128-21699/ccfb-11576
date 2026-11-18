/**
 * 性能基准（手动运行：npm run perf）。
 *
 * 测量双明手引擎在不同残局规模下的单题节点数与耗时，
 * 并对完整 13 张牌局做带预算的探测，避免 CI 中长时间阻塞。
 *
 * 注意：纯 TypeScript 的通用 alpha-beta 引擎在完整牌局上较慢，
 * 这里如实报告数字，不做粉饰。
 */
import { DDSolver, solveFullTable } from '../src/dds/solver.js';
import { mulberry32, shuffled } from '../src/rng.js';
import { emptyHand } from '../src/deal.js';
import type { Deal } from '../src/deal.js';
import type { Seat } from '../src/cards.js';

function randomDeal(seed: number): Deal {
  const rng = mulberry32(seed);
  const cards = shuffled(rng, Array.from({ length: 52 }, (_, i) => i));
  const deal: Deal = [emptyHand(), emptyHand(), emptyHand(), emptyHand()];
  cards.forEach((card, i) => {
    const seat = (i % 4) as Seat;
    const suit = Math.floor(card / 13) as 0 | 1 | 2 | 3;
    deal[seat]![suit]! |= 1 << (card % 13);
  });
  return deal;
}

function endgame(full: Deal, keep: number): Deal {
  const out: Deal = [emptyHand(), emptyHand(), emptyHand(), emptyHand()];
  for (let seat = 0; seat < 4; seat++) {
    let taken = 0;
    for (let suit = 0; suit < 4 && taken < keep; suit++) {
      let mask = full[seat]![suit]!;
      const want = keep - taken;
      let m = 0; let n = 0;
      while (mask && n < want) { const b = mask & -mask; m |= b; mask ^= b; n++; }
      out[seat]![suit]! = m;
      taken += n;
    }
  }
  return out;
}

console.log('=== 残局单题性能（NT，N 首引）===');
for (const keep of [2, 4, 6, 8]) {
  const deal = endgame(randomDeal(101), keep);
  const t0 = performance.now();
  const r = new DDSolver(deal).solve(4, 0 as Seat);
  console.log(
    `每手 ${keep} 张（共 ${keep * 4} 牌）：${r.nodes} 节点，` +
    `${(performance.now() - t0).toFixed(1)}ms，NS=${r.nsTricks}`,
  );
}

console.log('\n=== 完整 13 张牌局（带 2000 万节点预算探测）===');
const full = randomDeal(2024);
const solver = new DDSolver(full);
solver.nodeBudget = 20_000_000;
const t1 = performance.now();
const r = solver.solve(4, 0 as Seat);
const ms = performance.now() - t1;
if (solver.aborted) {
  console.log(`预算内未完成：${r.nodes} 节点，${ms.toFixed(0)}ms（结果不保证精确）`);
} else {
  console.log(`单题完成：${r.nodes} 节点，${ms.toFixed(0)}ms，NS=${r.nsTricks}`);
}

console.log('\n=== 引擎特性 ===');
console.log('Alpha-Beta（fail-soft）+ MTD(f) 零窗口 + PVS 侦察');
console.log('置换表（仅墩首读写，Zobrist 64 位）+ killer/history 走法排序');
console.log('等牌连张剪枝（领出时的自身严格支配规则，经 2040 组穷举对拍验证）');
void solveFullTable;
