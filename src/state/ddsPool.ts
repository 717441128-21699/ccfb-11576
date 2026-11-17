/**
 * DDS 调度器: 为一副牌的 5 个定约各启动一个 strain Worker 并行计算,
 * 汇总成 20 个双明手结果。复用同一批 Worker 处理多副牌。
 */

import { Hands, Strain } from '../engine/cards.ts';
import type { DDSStats } from '../engine/dds.ts';
import type { StrainJob, StrainResult } from '../workers/strain.worker.ts';

export interface FullDDResult {
  /** tricks[strain][leader] = NS 墩数 */
  tricks: number[][];
  stats: DDSStats[];
  elapsedMs: number;
}

export class DDSPool {
  private workers: Worker[] = [];
  private nextId = 1;

  private ensureWorkers(): Worker[] {
    if (this.workers.length === 0) {
      for (let i = 0; i < 5; i++) {
        this.workers.push(new Worker(new URL('../workers/strain.worker.ts', import.meta.url), { type: 'module' }));
      }
    }
    return this.workers;
  }

  solve(hands: Hands, onProgress?: (done: number, total: number) => void): Promise<FullDDResult> {
    const workers = this.ensureWorkers();
    const t0 = Date.now();
    const tricks: number[][] = Array.from({ length: 5 }, () => [0, 0, 0, 0]);
    const stats: DDSStats[] = [];
    let done = 0;

    return new Promise((resolve, reject) => {
      workers.forEach((worker, strain) => {
        const id = this.nextId++;
        const job: StrainJob = { kind: 'strain', id, hands, strain: strain as Strain };
        const handler = (ev: MessageEvent<StrainResult>) => {
          const res = ev.data;
          if (res.id !== id) return;
          worker.removeEventListener('message', handler);
          tricks[res.strain] = [...res.tricksNS];
          stats[res.strain] = res.stats;
          done++;
          onProgress?.(done, 5);
          if (done === 5) {
            resolve({ tricks, stats, elapsedMs: Date.now() - t0 });
          }
        };
        worker.addEventListener('message', handler);
        worker.addEventListener('error', (e) => reject(e), { once: true });
        worker.postMessage(job);
      });
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
