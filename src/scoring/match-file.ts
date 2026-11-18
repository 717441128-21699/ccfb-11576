import { type Trump, type Seat, NT } from '../cards.js';
import {
  type BoardResult,
  matchpointsForBoard,
  butlerImpForBoard,
  rankPairs,
  type PairTotal,
  resultNsScore,
} from './match.js';
import { type Vulnerability, scoreContract, toNsSigned, type Contract } from './contract.js';

/**
 * 比赛数据的导入与汇总。
 *
 * 输入 JSON 结构（一个比赛文件）：
 * {
 *   "scoring": "matchpoint" | "butler",
 *   "boards": [
 *     {
 *       "boardId": 1, "tableId": 1,
 *       "nsPairId": 1, "ewPairId": 2,
 *       "vul": 0,
 *       "contract": { "level": 3, "trump": 4, "declarer": 0, "doubled": 0 },
 *       "tricks": 9
 *     }
 *   ]
 * }
 */

export type ScoringKind = 'matchpoint' | 'butler';

export interface MatchFile {
  scoring: ScoringKind;
  boards: Array<{
    boardId: number;
    tableId: number;
    nsPairId: number;
    ewPairId: number;
    vul: Vulnerability;
    contract: {
      level: number;
      trump: Trump;
      declarer: Seat;
      doubled: 0 | 1 | 2;
    };
    tricks: number;
  }>;
}

export interface BoardLine {
  boardId: number;
  tableId: number;
  nsPairId: number;
  ewPairId: number;
  contract: Contract;
  tricks: number;
  vul: Vulnerability;
  nsScore: number;
  made: boolean;
}

export interface MatchReport {
  scoring: ScoringKind;
  lines: BoardLine[];
  ranking: PairTotal[];
  /** 每对总分的快速查表 */
  pairPoints: Map<number, number>;
}

export function parseMatchFile(json: string): MatchFile {
  const data = JSON.parse(json) as MatchFile;
  if (!Array.isArray(data.boards)) throw new Error('比赛文件缺少 boards 数组');
  if (data.scoring !== 'matchpoint' && data.scoring !== 'butler') {
    throw new Error('scoring 必须是 matchpoint 或 butler');
  }
  for (const b of data.boards) {
    if (b.contract.level < 1 || b.contract.level > 7) {
      throw new Error(`board ${b.boardId} 定约阶数非法`);
    }
    if (b.tricks < 0 || b.tricks > 13) {
      throw new Error(`board ${b.boardId} 墩数必须在 0..13`);
    }
    const t = b.contract.trump;
    if (t < 0 || t > 4) throw new Error(`board ${b.boardId} 将牌非法`);
  }
  return data;
}

/** 计算整场比赛的逐桌分数与最终排名 */
export function buildMatchReport(file: MatchFile): MatchReport {
  const lines: BoardLine[] = file.boards.map((b) => {
    const contract: Contract = { ...b.contract };
    const sr = scoreContract(contract, { tricks: b.tricks }, b.vul);
    return {
      boardId: b.boardId,
      tableId: b.tableId,
      nsPairId: b.nsPairId,
      ewPairId: b.ewPairId,
      contract,
      tricks: b.tricks,
      vul: b.vul,
      nsScore: toNsSigned(sr),
      made: sr.made,
    };
  });

  // 按副牌分组
  const byBoard = new Map<number, BoardResult[]>();
  for (const b of file.boards) {
    const list = byBoard.get(b.boardId) ?? [];
    list.push({
      boardId: b.boardId,
      tableId: b.tableId,
      nsPairId: b.nsPairId,
      ewPairId: b.ewPairId,
      contract: { ...b.contract },
      tricks: b.tricks,
      vul: b.vul,
    });
    byBoard.set(b.boardId, list);
  }

  const perBoard: Array<Map<number, number>> = [];
  for (const list of byBoard.values()) {
    perBoard.push(
      file.scoring === 'matchpoint'
        ? matchpointsForBoard(list)
        : butlerImpForBoard(list),
    );
  }
  const ranking = rankPairs(perBoard);
  const pairPoints = new Map<number, number>();
  for (const r of ranking) pairPoints.set(r.pairId, r.points);

  return { scoring: file.scoring, lines, ranking, pairPoints };
}

/** 单条成绩的 NS 分（供 UI/CLI 复用） */
export function scoreLineNs(b: BoardResult): number {
  return resultNsScore(b);
}

export function sampleMatchFile(): string {
  return JSON.stringify(
    {
      scoring: 'matchpoint',
      boards: [
        {
          boardId: 1, tableId: 1, nsPairId: 1, ewPairId: 2, vul: 0,
          contract: { level: 3, trump: NT, declarer: 0, doubled: 0 }, tricks: 9,
        },
        {
          boardId: 1, tableId: 2, nsPairId: 3, ewPairId: 4, vul: 0,
          contract: { level: 3, trump: NT, declarer: 0, doubled: 0 }, tricks: 10,
        },
        {
          boardId: 1, tableId: 3, nsPairId: 5, ewPairId: 6, vul: 0,
          contract: { level: 3, trump: NT, declarer: 0, doubled: 0 }, tricks: 8,
        },
      ],
    },
    null,
    2,
  );
}
