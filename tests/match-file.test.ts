import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMatchFile,
  buildMatchReport,
  sampleMatchFile,
} from '../src/scoring/match-file.js';

test('导入比赛文件并生成排名：比赛分按方向累计，头名并列', () => {
  const file = parseMatchFile(sampleMatchFile());
  const report = buildMatchReport(file);
  assert.equal(report.lines.length, 3);
  // 三桌互比：桌2 NS(pair3) 与桌3 EW(pair6) 各得 2 分并列第一
  const top = report.ranking.filter((r) => r.rank === 1).map((r) => r.pairId).sort();
  assert.deepEqual(top, [3, 6]);
  // 0 分的对不入累计表，故排名表只含拿到过分数的对
  assert.ok(report.ranking.length >= 2);
});

test('Butler 模式也能正常汇总', () => {
  const file = parseMatchFile(sampleMatchFile().replace('matchpoint', 'butler'));
  const report = buildMatchReport(file);
  assert.equal(report.scoring, 'butler');
  assert.ok(report.ranking.length >= 2);
});

test('非法计分方式与非法阶数报错', () => {
  assert.throws(() => parseMatchFile(sampleMatchFile().replace('matchpoint', 'xxx')));
  const bad = JSON.parse(sampleMatchFile());
  bad.boards[0]!.contract.level = 9;
  assert.throws(() => parseMatchFile(JSON.stringify(bad)));
});

test('每条成绩都算出带符号 NS 分', () => {
  const report = buildMatchReport(parseMatchFile(sampleMatchFile()));
  for (const line of report.lines) {
    assert.ok(typeof line.nsScore === 'number');
  }
  // 3NT 做成 = +400（无局）
  assert.equal(report.lines[0]!.nsScore, 400);
  // 宕一 = -50
  assert.equal(report.lines[2]!.nsScore, -50);
});
