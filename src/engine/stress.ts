/**
 * 无头压测：不启动 DOM，直接用虚拟时钟跑满指定帧数。
 * 供 vitest 与界面里的“5 分钟极限测试”共用。
 */

import { type FaultFlags, NO_FAULTS } from '../core/faults';
import type { NetworkConfig, RollbackConfig } from '../core/types';
import { FRAME_MS, Session, type SessionConfig } from './session';

export interface StressResult {
  frames: number;
  elapsedSimMs: number;
  divergences: number;
  rollbacks: number;
  resimulated: number;
  maxResimMs: number;
  stallFrames: number;
  passed: boolean;
}

export interface StressOptions {
  network: NetworkConfig;
  rollback: RollbackConfig;
  frames: number;
  useAI?: boolean;
  faults?: [FaultFlags, FaultFlags];
  /** 每跑多少帧让出一次事件循环（UI 用），<=0 表示不让步 */
  yieldEvery?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function runStress(opts: StressOptions): Promise<StressResult> {
  const config: SessionConfig = {
    network: opts.network,
    rollback: opts.rollback,
    useAI: opts.useAI ?? true,
  };
  const session = new Session(config, opts.faults ?? [
    { ...NO_FAULTS }, { ...NO_FAULTS },
  ]);

  const yieldEvery = opts.yieldEvery ?? 0;
  for (let f = 0; f < opts.frames; f++) {
    session.stepFrame();
    if (yieldEvery > 0 && f % yieldEvery === 0) {
      opts.onProgress?.(f, opts.frames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  opts.onProgress?.(opts.frames, opts.frames);

  const t = session.totals;
  return {
    frames: opts.frames,
    elapsedSimMs: opts.frames * FRAME_MS,
    divergences: session.totalDivergences,
    rollbacks: t.rollbacks,
    resimulated: t.resimulated,
    maxResimMs: t.maxResimMs,
    stallFrames: t.stallFrames,
    passed: session.totalDivergences === 0,
  };
}
