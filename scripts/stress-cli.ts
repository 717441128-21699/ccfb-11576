/**
 * 命令行版 5 分钟极限压测：
 *   npx vite-node scripts/stress-cli.ts
 *
 * 200ms 单向延迟 + 50% 丢包 + 乱序，18000 帧（300,000ms 模拟时长）。
 * 验收标准：divergences 必须为 0。
 */

import { DEFAULT_ROLLBACK, STRESS_NETWORK } from '../src/engine/session';
import { runStress } from '../src/engine/stress';

const FRAMES = 18000;
const result = await runStress({
  network: { ...STRESS_NETWORK },
  rollback: { ...DEFAULT_ROLLBACK, maxPredictedFrames: 60 },
  frames: FRAMES,
  useAI: true,
});

console.log('================ 5 分钟极限压测结果 ================');
console.log(`帧数           : ${result.frames}（${(result.elapsedSimMs / 1000).toFixed(1)}s 模拟时长）`);
console.log(`网络条件       : 200ms 延迟 ±30ms 抖动 / 50% 丢包 / 10% 乱序`);
console.log(`分歧次数       : ${result.divergences}`);
console.log(`回滚次数       : ${result.rollbacks}`);
console.log(`重算总帧数     : ${result.resimulated}`);
console.log(`最大单帧重算   : ${result.maxResimMs.toFixed(3)} ms`);
console.log(`卡顿帧         : ${result.stallFrames}`);
console.log('====================================================');
console.log(result.passed ? 'PASS：全程零分歧' : 'FAIL：检测到状态分歧');
if (!result.passed) throw new Error('极限压测未通过：检测到状态分歧');
