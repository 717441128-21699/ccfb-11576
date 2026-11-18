import { solveFullTable } from '../dds/solver.js';
import type { Deal } from '../deal.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

/**
 * 双明手 Web Worker 入口。
 * esbuild 以 worker 目标打包；运行时由主线程 new Worker() 加载。
 */
declare const self: {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
};

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.kind === 'solveFull') {
      const deal = msg.deal as Deal;
      const result = solveFullTable(deal, {
        onProgress: (done, total) => {
          self.postMessage({ kind: 'progress', done, total });
        },
      });
      self.postMessage({
        kind: 'done',
        table: result.table,
        millis: result.millis,
      });
    }
  } catch (e) {
    self.postMessage({
      kind: 'error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
