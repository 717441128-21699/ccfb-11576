/** 生成演示用的示例比赛数据: 8 副牌, 4 桌, 双人赛 */

import { makeBoards } from '../engine/tournament.ts';
import { dealRandomHands, makeRng, toPBNDeal, Seat } from '../engine/cards.ts';

export function buildSampleData(): {
  tsv: string;
  pbnDeals: string[];
  boardCount: number;
} {
  const rng = makeRng(20261118);
  const boardCount = 8;
  const tableCount = 4;
  const pbnDeals: string[] = [];
  const rows: string[] = ['board\ttable\tns\tew\tcontract\tdeclarer\ttricks'];

  const strains = ['1NT', '2S', '3NT', '4H', '4S', '5C', '3D', '6NT'];
  const levels = [1, 2, 3, 4, 4, 5, 3, 6];
  const declarers: Seat[] = [0, 2, 1, 3, 0, 2, 1, 3];

  for (let b = 1; b <= boardCount; b++) {
    const hands = dealRandomHands(rng);
    pbnDeals.push(toPBNDeal(hands, 0));
    const level = levels[b - 1]!;
    for (let t = 1; t <= tableCount; t++) {
      // 各桌成绩在基准墩数附近浮动
      const base = level + 6;
      const delta = Math.floor(rng() * 4) - 1; // -1..2
      const tricks = Math.max(0, Math.min(13, base + delta));
      const nsPair = `NS${((b + t) % tableCount) + 1}`;
      const ewPair = `EW${((b * 2 + t) % tableCount) + 1}`;
      rows.push([b, `T${t}`, nsPair, ewPair, strains[b - 1], 'NESW'[declarers[b - 1]!], tricks].join('\t'));
    }
  }

  void makeBoards;
  return { tsv: rows.join('\n'), pbnDeals, boardCount };
}
