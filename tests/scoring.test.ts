import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreContract,
  toNsSigned,
  contractName,
  VUL_NONE,
  VUL_NS,
  VUL_BOTH,
  type Contract,
} from '../src/scoring/contract.js';
import { diffToImp, signedImp } from '../src/scoring/imp.js';
import {
  matchpointsForBoard,
  butlerImpForBoard,
  rankPairs,
  teamImp,
  type BoardResult,
} from '../src/scoring/match.js';
import { NT } from '../src/cards.js';

function c(partial: Partial<Contract>): Contract {
  return {
    level: 1,
    trump: NT,
    declarer: 0,
    doubled: 0,
    ...partial,
  };
}

test('无局 1NT 刚好做成：40+30 墩分 + 50 部分定约奖 = 90', () => {
  const r = scoreContract(c({ level: 1, trump: NT, declarer: 2 }), { tricks: 7 }, VUL_NONE);
  assert.equal(r.score, 90);
  assert.equal(r.scoreSide, 0); // S 坐庄，NS 方
  assert.equal(r.made, true);
});

test('无局 3NT 做成：100 墩分 + 300 成局奖 = 400', () => {
  const r = scoreContract(c({ level: 3, trump: NT, declarer: 0 }), { tricks: 9 }, VUL_NONE);
  assert.equal(r.score, 400);
});

test('有局 4♥ 做成：120 墩分 + 500 成局奖 = 620', () => {
  const r = scoreContract(c({ level: 4, trump: 2, declarer: 0 }), { tricks: 10 }, VUL_NS);
  assert.equal(r.score, 620);
});

test('低花成局 5♣ 做成：100 墩分 + 300 = 400（无局）', () => {
  const r = scoreContract(c({ level: 5, trump: 0, declarer: 2 }), { tricks: 11 }, VUL_NONE);
  assert.equal(r.score, 400);
});

test('小满贯 6♠ 无局做成：180+300+500 = 980', () => {
  const r = scoreContract(c({ level: 6, trump: 3, declarer: 0 }), { tricks: 12 }, VUL_NONE);
  assert.equal(r.score, 980);
});

test('大满贯 7NT 有局：220 墩分 +500 成局 +1500 大满 = 2220', () => {
  const r = scoreContract(c({ level: 7, trump: NT, declarer: 2 }), { tricks: 13 }, VUL_BOTH);
  assert.equal(r.score, 2220);
});

test('宕一：无局 -50，有局 -100（从对家视角计分）', () => {
  const downNV = scoreContract(c({ declarer: 0 }), { tricks: 6 }, VUL_NONE);
  assert.equal(downNV.score, 50);
  assert.equal(downNV.scoreSide, 1); // EW 得分
  assert.equal(toNsSigned(downNV), -50);

  const downV = scoreContract(c({ declarer: 0 }), { tricks: 6 }, VUL_NS);
  assert.equal(downV.score, 100);
  assert.equal(toNsSigned(downV), -100);
});

test('加倍宕分：无局宕三 500，有局宕三 800', () => {
  const nv = scoreContract(c({ declarer: 0, doubled: 1 }), { tricks: 4 }, VUL_NONE); // 1 阶需 7，拿 4 宕 3
  assert.equal(nv.score, 500);
  const v = scoreContract(c({ declarer: 0, doubled: 1 }), { tricks: 4 }, VUL_BOTH);
  assert.equal(v.score, 800);
});

test('加倍做成含侮辱性奖分与加倍超墩', () => {
  // 无局 1NTX 拿 8（超一）：墩分 (40+30)*2... 实际 1NT 墩分 40，加倍后 80；奖 50 侮辱 +50 部分；超墩无局 100
  const r = scoreContract(c({ level: 1, trump: NT, declarer: 0, doubled: 1 }), { tricks: 8 }, VUL_NONE);
  // 80 + 50 + 50 + 100 = 280
  assert.equal(r.score, 280);
});

test('IMP 换算表边界', () => {
  assert.equal(diffToImp(0), 0);
  assert.equal(diffToImp(20), 0);
  assert.equal(diffToImp(40), 1);
  assert.equal(diffToImp(150), 4);
  assert.equal(diffToImp(740), 12);
  assert.equal(diffToImp(3990), 23);
  assert.equal(signedImp(-150), -4);
});

test('比赛分：三桌同副，最高分者得 2 个比赛分', () => {
  const results: BoardResult[] = [
    { boardId: 1, tableId: 1, nsPairId: 1, ewPairId: 2, contract: c({ level: 3, trump: NT, declarer: 0 }), tricks: 9, vul: VUL_NONE },
    { boardId: 1, tableId: 2, nsPairId: 3, ewPairId: 4, contract: c({ level: 3, trump: NT, declarer: 0 }), tricks: 10, vul: VUL_NONE },
    { boardId: 1, tableId: 3, nsPairId: 5, ewPairId: 6, contract: c({ level: 3, trump: NT, declarer: 0 }), tricks: 8, vul: VUL_NONE },
  ];
  const mp = matchpointsForBoard(results);
  assert.equal(mp.get(3), 2); // 超墩那桌 NS 最强
  assert.equal(mp.get(5) ?? 0, 0); // 宕的那桌 NS 最弱（0 分可能不入 Map）
  assert.equal(mp.get(6), 2); // 对应 EW 对家反而拿满分
});

test('平均 IMP：基准为其余桌均值，符号随方向反转', () => {
  const results: BoardResult[] = [
    { boardId: 1, tableId: 1, nsPairId: 1, ewPairId: 2, contract: c({ level: 3, trump: NT, declarer: 0 }), tricks: 11, vul: VUL_NONE },
    { boardId: 1, tableId: 2, nsPairId: 3, ewPairId: 4, contract: c({ level: 3, trump: NT, declarer: 0 }), tricks: 9, vul: VUL_NONE },
  ];
  const imp = butlerImpForBoard(results);
  // 桌 1 NS 得分高，应为正 IMP；其 EW 对家应为负
  assert.ok(imp.get(1)! > 0);
  assert.ok(imp.get(2)! < 0);
});

test('排名：分数降序，并列同名次', () => {
  // pair1=12、pair3=12 并列第一，pair2=8 列第三（跳过名次 2）
  const boards = [
    new Map([[1, 10], [2, 5], [3, 10]]),
    new Map([[1, 2], [2, 3], [3, 2]]),
  ];
  const ranked = rankPairs(boards);
  assert.equal(ranked[0]!.points, 12);
  assert.equal(ranked[0]!.rank, 1);
  assert.equal(ranked[1]!.points, 12);
  assert.equal(ranked[1]!.rank, 1); // 与前者并列
  assert.equal(ranked[2]!.pairId, 2);
  assert.equal(ranked[2]!.points, 8);
  assert.equal(ranked[2]!.rank, 3); // 并列占了两个第 1，下一名次为 3
});

test('队际 IMP：两桌分差正确换算', () => {
  assert.equal(teamImp(420, 0), diffToImp(420));
  assert.equal(teamImp(0, 420), -9);
});

test('contractName 人类可读', () => {
  assert.equal(contractName(c({ level: 4, trump: 2, declarer: 1, doubled: 1 })), '4♥X E');
  assert.equal(contractName(c({ level: 3, trump: NT, declarer: 0 })), '3NT N');
});
