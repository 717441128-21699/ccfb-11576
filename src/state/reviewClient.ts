/** 复盘 Worker 的前端封装 (Promise 化) */

import type { Strain, Seat, Suit, Hands } from '../engine/cards.ts';
import type { PlayedCard } from '../engine/dds.ts';
import type { AssessJob, AssessResult, AssessMove } from '../workers/review.worker.ts';

export class ReviewClient {
  private worker: Worker;
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL('../workers/review.worker.ts', import.meta.url), { type: 'module' });
  }

  assess(
    hands: Hands,
    strain: Strain,
    currentTrick: PlayedCard[],
    turn: Seat,
    nsBanked: number,
    ewBanked: number,
  ): Promise<AssessMove[]> {
    const id = this.nextId++;
    const job: AssessJob = { kind: 'assess', id, hands, strain, currentTrick, turn, nsBanked, ewBanked };
    return new Promise((resolve, reject) => {
      const handler = (ev: MessageEvent<AssessResult>) => {
        if (ev.data.id !== id) return;
        this.worker.removeEventListener('message', handler);
        resolve(ev.data.moves);
      };
      this.worker.addEventListener('message', handler);
      this.worker.addEventListener('error', (e) => reject(e), { once: true });
      this.worker.postMessage(job);
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

export type { AssessMove, Suit };
