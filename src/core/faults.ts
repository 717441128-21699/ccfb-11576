/**
 * 故障注入（默认全部关闭）。
 *
 * 用于验证“同步检查”页能否真的定位问题：在指定端点注入三类典型 bug，
 * 只在一端开启，制造确定性分歧。
 *
 * 触发键用【全局真实帧号】而非端点自己的模拟帧号——输入延迟和网络
 * 延迟会让两端模拟帧号暂时错位，用模拟帧号取模会让两端在同一帧上
 * 同时触发故障，分歧互相抵消。
 *
 *  - physics: 每隔 37 个真实帧给玩家 0 的 vx 多加 1（典型整数物理写错常量）
 *  - rng:     每隔 53 个真实帧额外推进一次 RNG（典型分支里漏调/多调随机数）
 *  - input:   每隔 41 个真实帧吞掉攻击键（典型输入边沿/采样处理错误）
 */

import type { Input, WorldState } from './types';
import { INPUT_BITS } from './types';

export interface FaultFlags {
  physics: boolean;
  rng: boolean;
  input: boolean;
}

export const NO_FAULTS: FaultFlags = { physics: false, rng: false, input: false };

export function cloneFaults(f: FaultFlags): FaultFlags {
  return { ...f };
}

/**
 * 在端点执行某帧输入前调用：返回可能被破坏的输入。
 *
 * 输入故障：在故障真实帧对“本端负责采样的玩家”输入做一次确定性的
 * 低位翻转。直接翻转移动/跳跃位能保证产生可观测的状态差异，
 * 且差异源头明确是输入处理，同步检查可稳定归类为 input。
 */
export function corruptInput(
  input: Input,
  realFrame: number,
  faults: FaultFlags,
): Input {
  if (faults.input && realFrame > 0 && realFrame % 41 === 0) {
    // 在 LEFT 与 RIGHT 之间确定性翻转一个位
    const flipBit = realFrame % 82 === 0 ? INPUT_BITS.LEFT : INPUT_BITS.RIGHT;
    return { bits: input.bits ^ flipBit };
  }
  return input;
}

/** 在端点步进一帧后调用：物理 / 随机数类故障 */
export function applyPostStep(
  state: WorldState,
  realFrame: number,
  faults: FaultFlags,
): void {
  if (realFrame <= 0) return;
  if (faults.physics && realFrame % 37 === 0) {
    state.players[0].vx += 1;
  }
  if (faults.rng && realFrame % 53 === 0) {
    // 与 rng.ts 中完全相同的 LCG 推进，多走一步
    state.rngState = (Math.imul(state.rngState, 1664525) + 1013904223) | 0;
  }
}
