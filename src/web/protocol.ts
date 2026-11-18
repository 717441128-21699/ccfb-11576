import type { Deal } from '../deal.js';
import type { DoubleDummyTable } from '../dds/solver.js';
import type { Trump, Seat } from '../cards.js';

/**
 * 主线程与双明手 Web Worker 之间的消息协议。
 * 把 20 个（将牌 × 首引）问题放进 Worker，避免阻塞界面。
 */

export interface SolveRequest {
  kind: 'solveFull';
  /** Deal 可结构化克隆，直接传递 */
  deal: Deal;
}

export interface SolveProgress {
  kind: 'progress';
  done: number;
  total: number;
}

export interface SolveResponse {
  kind: 'done';
  table: DoubleDummyTable;
  millis: number;
}

export interface SolveError {
  kind: 'error';
  message: string;
}

export type WorkerRequest = SolveRequest;
export type WorkerResponse = SolveProgress | SolveResponse | SolveError;

/** 复盘单步评估请求 */
export interface ReviewEvalRequest {
  kind: 'reviewEval';
  deal: Deal;
  trump: Trump;
  leader: Seat;
}

export interface ReviewEvalResponse {
  kind: 'reviewEvalDone';
  /** 每张合法牌的 NS 墩数结果，由主线程 ReviewEngine 消费 */
  table: DoubleDummyTable;
}
