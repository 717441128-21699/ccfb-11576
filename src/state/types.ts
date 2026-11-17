import { Strain, Seat, Hands } from '../engine/cards.ts';

/** 一副牌的 20 个双明手结果: 按定约 x 领出座位索引 */
export interface DDResults {
  /** tricks[strain][leader] = NS 墩数 */
  tricks: number[][];
  elapsedMs: number;
}

export interface DealRecord {
  boardNumber: number;
  hands: Hands;
  dealer: Seat;
  vulnNS: 0 | 1;
  vulnEW: 0 | 1;
  dd?: DDResults;
  ddState: 'idle' | 'computing' | 'done' | 'error';
  ddError?: string;
}

export interface AppData {
  boards: import('../engine/tournament.ts').Board[];
  entries: import('../engine/tournament.ts').TableEntry[];
  deals: DealRecord[];
  scoringMethod: 'MP' | 'IMP';
}

export const STRAIN_LABELS = ['梅花 C', '方块 D', '红桃 H', '黑桃 S', '无将 NT'];

export function declarerTricksFromNS(nsTricks: number, declarer: Seat): number {
  return (declarer & 1) === 0 ? nsTricks : 13 - nsTricks;
}

export function strainLabel(strain: Strain): string {
  return STRAIN_LABELS[strain]!;
}
