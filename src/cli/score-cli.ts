/**
 * 命令行：导入比赛 JSON，输出每桌分数与最终排名。
 * 用法：node --loader ./scripts/ts-loader.mjs src/cli/score-cli.ts <比赛文件.json>
 */
import { readFile } from 'node:fs/promises';
import { parseMatchFile, buildMatchReport } from '../scoring/match-file.js';
import { contractName } from '../scoring/contract.js';

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('用法：score-cli.ts <比赛文件.json>');
    process.exit(1);
  }
  const json = await readFile(path, 'utf8');
  const file = parseMatchFile(json);
  const report = buildMatchReport(file);

  console.log(`计分方式：${report.scoring === 'matchpoint' ? '比赛分 (Matchpoint)' : '平均 IMP (Butler)'}`);
  console.log('\n=== 各桌成绩（NS 视角带符号分）===');
  for (const line of report.lines) {
    console.log(
      `第 ${String(line.boardId).padStart(2)} 副 桌${line.tableId} ` +
      `${contractName(line.contract)} 拿${line.tricks}墩 ` +
      `NS对${line.nsPairId} / EW对${line.ewPairId} => ${line.nsScore >= 0 ? '+' : ''}${line.nsScore}`,
    );
  }

  console.log('\n=== 最终排名 ===');
  for (const r of report.ranking) {
    console.log(`第 ${r.rank} 名：牌号 ${r.pairId}，总分 ${r.points}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
