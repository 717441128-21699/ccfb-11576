/**
 * 确定性随机数：32 位 LCG（数值配方参数，同 glibc 的 j=4 变体）。
 *
 * 关键性质：
 *  - 纯整数运算（Math.imul 模拟 int32 溢出），不依赖 Math.random / Date；
 *  - 相同种子 + 相同调用序列 => 两端逐位相同的输出；
 *  - rngState 本身是同步状态的一部分，参与哈希。
 *
 * 注意：LCG 不是密码学安全随机数，这里只需要“两端一致的伪随机”。
 */

export interface Rng {
  state: number;
}

export function createRng(seed: number): Rng {
  // 种子先做一次混合，避免 0 种子直接卡死
  return { state: Math.imul(seed ^ 0x9e3779b9, 1664525) + 1013904223 | 0 };
}

/** 推进一次并返回 [0, 2^32) 的无符号 32 位值 */
export function nextU32(rng: Rng): number {
  // LCG: s' = s * 1664525 + 1013904223 (mod 2^32)
  rng.state = (Math.imul(rng.state, 1664525) + 1013904223) | 0;
  return rng.state >>> 0;
}

/** 返回 [0, bound) 内的整数，bound 必须为正整数 */
export function nextInt(rng: Rng, bound: number): number {
  return nextU32(rng) % bound;
}

/** 返回 [lo, hi] 闭区间内的整数 */
export function rangeInt(rng: Rng, lo: number, hi: number): number {
  return lo + nextInt(rng, hi - lo + 1);
}
