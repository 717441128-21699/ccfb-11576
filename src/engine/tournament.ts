/**
 * 复式赛数据模型与成绩聚合。
 * 一场比赛由若干副牌 (Board) 组成, 每副牌在若干桌上进行, 每桌一条录入。
 */

import { BoardScoreInput, Contract, Doubled, Vulnerability, matchpoints, crossImps, teamImp, scoreBoard, nsScore, rankByTotal } from './scoring.ts';
import { Seat, Strain, SEATS, STRAINS, Hands } from './cards.ts';

export interface Board {
  boardNumber: number;
  dealer: Seat;
  /** NS 局况 / EW 局况 */
  vulnNS: Vulnerability;
  vulnEW: Vulnerability;
  hands?: Hands; // 可选: 有发牌数据才能做双明手复盘
}

export interface TableEntry {
  boardNumber: number;
  tableId: string;
  nsPairId: string;
  ewPairId: string;
  contract: Contract | null; // null = 全 pass
  tricks: number; // 庄家方总墩数; 全 pass 填 0
}

export interface ScoredEntry extends TableEntry {
  declarerScore: number; // 庄家方视角分
  nsViewScore: number; // NS 视角分
}

/** 标准局况轮转: 16 副一循环 (N None, E NS, S EW, W All) */
export function standardVulnerability(boardNumber: number): { vulnNS: Vulnerability; vulnEW: Vulnerability; dealer: Seat } {
  const b = ((boardNumber - 1) % 16 + 16) % 16;
  const dealer = (b % 4) as Seat;
  // 局况: board 1 无, 2 NS, 3 EW, 4 双, 5 NS, 6 EW, 7 双, 8 无 ...
  const cycle: Array<[Vulnerability, Vulnerability]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 1],
    [1, 1],
    [0, 0],
    [0, 1],
    [1, 1],
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
    [1, 0],
    [0, 1],
  ];
  const [vulnNS, vulnEW] = cycle[b]!;
  return { vulnNS, vulnEW, dealer };
}

export function makeBoards(count: number, hands?: Hands[]): Board[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const v = standardVulnerability(n);
    return { boardNumber: n, ...v, hands: hands?.[i] };
  });
}

export function scoreEntry(board: Board, entry: TableEntry): ScoredEntry {
  const vuln: Vulnerability = entry.contract === null
    ? 0
    : isDeclarerNS(entry.contract)
      ? board.vulnNS
      : board.vulnEW;
  const input: BoardScoreInput = {
    contract: entry.contract,
    tricks: entry.tricks,
    vulnerability: vuln,
  };
  const declarerScore = scoreBoard(input);
  const nsViewScore = entry.contract === null ? 0 : nsScore(entry.contract.declarer, declarerScore);
  return { ...entry, declarerScore, nsViewScore };
}

/** 庄家是否属于 NS 方 */
export function isDeclarerNS(contract: Contract): boolean {
  return (contract.declarer & 1) === 0;
}

export type ScoringMethod = 'MP' | 'IMP' | 'TEAM_IMP';

export interface PairResult {
  pairId: string;
  direction: 'NS' | 'EW';
  total: number; // 合计比赛分/IMP
  perBoard: { boardNumber: number; points: number; maxPoints: number }[];
  rank: number;
}

/**
 * 双人赛聚合: 每副牌同方向的各桌先比较, 再按对累加。
 * MP: 每副内部归一化为 0..(同方向桌数-1) 的比赛分。
 * IMP: 交叉 IMP 总分。
 */
export function aggregatePairs(boards: Board[], entries: TableEntry[], method: 'MP' | 'IMP' = 'MP'): PairResult[] {
  const scored = entries.map((e) => {
    const board = boards.find((b) => b.boardNumber === e.boardNumber)!;
    return scoreEntry(board, e);
  });

  type Acc = { pairId: string; direction: 'NS' | 'EW'; total: number; perBoard: PairResult['perBoard'] };
  const acc = new Map<string, Acc>();
  const ensure = (pairId: string, direction: 'NS' | 'EW'): Acc => {
    let a = acc.get(pairId);
    if (!a) {
      a = { pairId, direction, total: 0, perBoard: [] };
      acc.set(pairId, a);
    }
    return a;
  };

  const boardNumbers = [...new Set(scored.map((e) => e.boardNumber))].sort((a, b) => a - b);
  for (const bn of boardNumbers) {
    const onBoard = scored.filter((e) => e.boardNumber === bn);
    for (const dir of ['NS', 'EW'] as const) {
      const rows = dir === 'NS'
        ? onBoard.map((e) => ({ pair: e.nsPairId, score: e.nsViewScore }))
        : onBoard.map((e) => ({ pair: e.ewPairId, score: -e.nsViewScore }));
      const values = rows.map((r) => r.score);
      const points = method === 'MP' ? matchpoints(values) : crossImps(values);
      const maxPoints = method === 'MP' ? Math.max(0, rows.length - 1) : 0;
      rows.forEach((r, i) => {
        ensure(r.pair, dir).perBoard.push({ boardNumber: bn, points: points[i]!, maxPoints });
        ensure(r.pair, dir).total += points[i]!;
      });
    }
  }

  const ranked = rankByTotal([...acc.values()].map((a) => ({ id: a.pairId, total: a.total })));
  return [...acc.values()].map((a) => ({
    ...a,
    rank: ranked.find((r) => r.id === a.pairId)!.rank,
  })).sort((x, y) => x.rank - y.rank || x.pairId.localeCompare(y.pairId));
}

/**
 * 队式赛: 每副牌恰好两桌 (开放队式/主客两桌), 按 NS 视角分差算 IMP,
 * 累加到 (nsPairId@tableA + ewPairId@tableB) 组成的队伍上。
 * 这里简化: 用 "队伍ID" 列 (teamId) 标识; 没有 teamId 时用 nsPair 作为队 ID。
 */
export interface TeamEntry extends TableEntry {
  teamId: string;
}

export interface TeamResult {
  teamId: string;
  totalImp: number;
  perBoard: { boardNumber: number; imp: number }[];
  rank: number;
}

export function aggregateTeams(boards: Board[], entries: TeamEntry[]): TeamResult[] {
  const scored = entries.map((e) => {
    const board = boards.find((b) => b.boardNumber === e.boardNumber)!;
    return { ...scoreEntry(board, e), teamId: e.teamId };
  });

  const boardNumbers = [...new Set(scored.map((e) => e.boardNumber))].sort((a, b) => a - b);
  const perTeam = new Map<string, TeamResult>();
  const ensure = (teamId: string): TeamResult => {
    let t = perTeam.get(teamId);
    if (!t) {
      t = { teamId, totalImp: 0, perBoard: [], rank: 0 };
      perTeam.set(teamId, t);
    }
    return t;
  };

  for (const bn of boardNumbers) {
    const rows = scored.filter((e) => e.boardNumber === bn);
    if (rows.length !== 2) throw new Error(`第 ${bn} 副队式赛需要恰好两桌记录, 实际 ${rows.length} 条`);
    const a = rows[0]!;
    const b = rows[1]!;
    // 同队两桌方向相反; 队伍净 IMP = 本队在 A 桌 NS 视角 IMP - 对手视角
    const impA = teamImp(a.nsViewScore, b.nsViewScore);
    const teamA = a.teamId;
    const teamB = b.teamId;
    ensure(teamA).perBoard.push({ boardNumber: bn, imp: impA });
    ensure(teamA).totalImp += impA;
    ensure(teamB).perBoard.push({ boardNumber: bn, imp: -impA });
    ensure(teamB).totalImp -= impA;
  }

  const ranked = rankByTotal([...perTeam.values()].map((t) => ({ id: t.teamId, total: t.totalImp })));
  return [...perTeam.values()].map((t) => ({
    ...t,
    rank: ranked.find((r) => r.id === t.teamId)!.rank,
  })).sort((x, y) => x.rank - y.rank);
}

// ---------------------------------------------------------------- 文本导入

export interface ParsedRow {
  boardNumber: number;
  tableId: string;
  nsPairId: string;
  ewPairId: string;
  contract: Contract | null;
  tricks: number;
  teamId?: string;
}

const STRAIN_CHAR: Record<string, Strain> = { C: 0, D: 1, H: 2, S: 3, NT: 4, N: 4 };

/**
 * 解析定约文本, 如 "4Sx"、"3NT"、"6Hxx"、"pass"。
 * 需另外给出庄家座位 (N/E/S/W)。
 */
export function parseContract(text: string, declarer: Seat): Contract | null {
  const t = text.trim().toUpperCase();
  if (t === '' || t === 'PASS' || t === '-' || t === '/') return null;
  const m = t.match(/^([1-7])(NT|[CDHS])(X{0,2})$/);
  if (!m) throw new Error(`无法识别的定约: ${text}`);
  const level = Number(m[1]);
  const strain = STRAIN_CHAR[m[2]!]!;
  const doubled = (m[3] === 'X' ? 1 : m[3] === 'XX' ? 2 : 0) as Doubled;
  return { level, strain, doubled, declarer };
}

/**
 * 导入 TSV/CSV。表头 (大小写不敏感, 支持中英文):
 * board/副号, table/桌, ns/北南对, ew/东西对, contract/定约, declarer/庄家,
 * tricks/墩数, team/队 (可选)
 */
export function parseEntries(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('导入内容至少需要表头和一行数据');
  const delim = lines[0]!.includes('\t') ? '\t' : ',';
  const header = splitCsvLine(lines[0]!, delim).map((h) => h.trim().toLowerCase());
  const idx = (names: string[]): number => header.findIndex((h) => names.includes(h));

  const iBoard = idx(['board', 'boardnumber', '副号', '牌号']);
  const iTable = idx(['table', 'tableid', '桌', '桌号']);
  const iNs = idx(['ns', 'nspair', 'ns_pair', '北南对', 'ns对']);
  const iEw = idx(['ew', 'ewpair', 'ew_pair', '东西对', 'ew对']);
  const iContract = idx(['contract', '定约']);
  const iDeclarer = idx(['declarer', '庄家']);
  const iTricks = idx(['tricks', '墩数', '总墩数']);
  const iTeam = idx(['team', 'teamid', '队', '队伍']);

  for (const [i, name] of [[iBoard, '副号'], [iNs, 'NS对'], [iEw, 'EW对'], [iContract, '定约'], [iDeclarer, '庄家'], [iTricks, '墩数']] as const) {
    if (i < 0) throw new Error(`导入缺少必需列: ${name}`);
  }

  const rows: ParsedRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = splitCsvLine(lines[li]!, delim);
    const declarerChar = cols[iDeclarer]!.trim().toUpperCase();
    const declarer = SEATS.indexOf(declarerChar as (typeof SEATS)[number]);
    if (declarer < 0) throw new Error(`第 ${li + 1} 行庄家座位无效: ${declarerChar}`);
    const contract = parseContract(cols[iContract]!, declarer as Seat);
    const tricks = Number(cols[iTricks]!.trim());
    if (contract !== null && (!Number.isInteger(tricks) || tricks < 0 || tricks > 13)) {
      throw new Error(`第 ${li + 1} 行墩数无效: ${cols[iTricks]}`);
    }
    rows.push({
      boardNumber: Number(cols[iBoard]!.trim()),
      tableId: iTable >= 0 ? cols[iTable]!.trim() : `T${li}`,
      nsPairId: cols[iNs]!.trim(),
      ewPairId: cols[iEw]!.trim(),
      contract,
      tricks: contract === null ? 0 : tricks,
      teamId: iTeam >= 0 ? cols[iTeam]!.trim() : undefined,
    });
  }
  return rows;
}

function splitCsvLine(line: string, delim: string): string[] {
  if (delim === '\t') return line.split('\t');
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function entriesToTsv(entries: TableEntry[]): string {
  const header = ['board', 'table', 'ns', 'ew', 'contract', 'declarer', 'tricks'];
  const lines = [header.join('\t')];
  for (const e of entries) {
    const c = e.contract
      ? `${e.contract.level}${STRAINS[e.contract.strain]}${e.contract.doubled === 1 ? 'x' : e.contract.doubled === 2 ? 'xx' : ''}`
      : 'pass';
    lines.push([e.boardNumber, e.tableId, e.nsPairId, e.ewPairId, c, e.contract ? SEATS[e.contract.declarer] : '-', e.tricks].join('\t'));
  }
  return lines.join('\n');
}
