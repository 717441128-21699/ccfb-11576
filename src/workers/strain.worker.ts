/**
 * 单 strain Worker: 计算一副牌在某一定约下、四个领出座位的双明手结果。
 * 主控线程为 5 个定约各启动一个 Worker, 并行跑满多核。
 */

import { Hands, Strain, Seat } from '../engine/cards.ts';
import { DoubleDummySolver, TranspositionTable, type DDSStats } from '../engine/dds.ts';

export interface StrainJob {
  kind: 'strain';
  id: number;
  hands: Hands;
  strain: Strain;
}

export interface StrainResult {
  kind: 'strain';
  id: number;
  strain: Strain;
  /** 四个领出座位的 NS 墩数 */
  tricksNS: Int8Array;
  stats: DDSStats;
  elapsedMs: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<StrainJob>) => {
  const msg = ev.data;
  if (msg.kind !== 'strain') return;
  const t0 = Date.now();
  const tt = new TranspositionTable(22);
  const solver = new DoubleDummySolver(msg.hands, msg.strain, tt);
  const tricksNS = new Int8Array(4);
  for (let leader = 0; leader < 4; leader++) {
    tricksNS[leader] = solver.solveFromTrickStart(leader as Seat);
  }
  const res: StrainResult = {
    kind: 'strain',
    id: msg.id,
    strain: msg.strain,
    tricksNS,
    stats: { ...solver.stats },
    elapsedMs: Date.now() - t0,
  };
  ctx.postMessage(res);
};
