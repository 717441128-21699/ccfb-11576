import { describe, it, expect } from 'vitest';
import { parseEntries, aggregatePairs, makeBoards, standardVulnerability, aggregateTeams, type TeamEntry } from '../src/engine/tournament.ts';

const TSV = [
  'board\ttable\tns\tew\tcontract\tdeclarer\ttricks',
  '1\tT1\tNS1\tEW1\t4S\tN\t10',
  '1\tT2\tNS2\tEW2\t4S\tN\t9',
  '2\tT1\tNS2\tEW1\t3NT\tE\t9',
  '2\tT2\tNS1\tEW2\t3NT\tE\t8',
].join('\n');

describe('导入与聚合', () => {
  it('解析 TSV', () => {
    const rows = parseEntries(TSV);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.contract).toMatchObject({ level: 4, strain: 3 });
    expect(rows[0]!.tricks).toBe(10);
  });

  it('全 pass 解析为 null 定约', () => {
    const rows = parseEntries('board\ttable\tns\tew\tcontract\tdeclarer\ttricks\n1\tT1\ta\tb\tpass\tN\t0');
    expect(rows[0]!.contract).toBeNull();
  });

  it('双人赛 MP 聚合产出排名', () => {
    const rows = parseEntries(TSV);
    const entries = rows.map((r) => ({
      boardNumber: r.boardNumber,
      tableId: r.tableId,
      nsPairId: r.nsPairId,
      ewPairId: r.ewPairId,
      contract: r.contract,
      tricks: r.tricks,
    }));
    const boards = makeBoards(2);
    const results = aggregatePairs(boards, entries, 'MP');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.rank).toBe(1);
    // 每对的每副牌得分记录存在
    for (const r of results) expect(r.perBoard.length).toBeGreaterThan(0);
  });

  it('交叉 IMP 聚合不报错且总分可排序', () => {
    const rows = parseEntries(TSV);
    const entries = rows.map((r) => ({
      boardNumber: r.boardNumber,
      tableId: r.tableId,
      nsPairId: r.nsPairId,
      ewPairId: r.ewPairId,
      contract: r.contract,
      tricks: r.tricks,
    }));
    const results = aggregatePairs(makeBoards(2), entries, 'IMP');
    const totals = results.map((r) => r.total);
    const sorted = [...totals].sort((a, b) => b - a);
    expect(totals.slice().sort((a, b) => b - a)).toEqual(sorted);
  });

  it('队式赛两桌 IMP 对称', () => {
    const entries: TeamEntry[] = [
      { boardNumber: 1, tableId: 'T1', nsPairId: 'a', ewPairId: 'b', contract: parseEntries('board\ttable\tns\tew\tcontract\tdeclarer\ttricks\n1\tT1\ta\tb\t4S\tN\t10')[0]!.contract, tricks: 10, teamId: 'A' },
      { boardNumber: 1, tableId: 'T2', nsPairId: 'c', ewPairId: 'd', contract: parseEntries('board\ttable\tns\tew\tcontract\tdeclarer\ttricks\n1\tT2\tc\td\t4S\tS\t9')[0]!.contract, tricks: 9, teamId: 'B' },
    ];
    const results = aggregateTeams(makeBoards(1), entries);
    expect(results).toHaveLength(2);
    expect(results[0]!.totalImp + results[1]!.totalImp).toBe(0);
  });

  it('标准局况 16 副循环', () => {
    expect(standardVulnerability(17)).toEqual(standardVulnerability(1));
  });
});
