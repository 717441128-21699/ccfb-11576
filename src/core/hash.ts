/**
 * 确定性状态哈希与分歧定位。
 *
 * 哈希：把 WorldState 按固定字段顺序展平成整数序列，做 FNV-1a（32 位）。
 * 两端同帧哈希不同即发生分歧；随后按“模拟写入顺序”逐字段比对，
 * 找出第一个被写错的变量并归类原因。
 */

import type { DivergenceReport, Input, WorldState } from './types';

/** 按模拟内部的写入顺序排列字段，越靠前越接近“最初写错的位置” */
const PLAYER_FIELDS: (keyof WorldState['players'][number])[] = [
  'jumpBuffer',
  'coyote',
  'attackCooldown',
  'attackTimer',
  'hurtTimer',
  'vx',
  'facing',
  'vy',
  'x',
  'y',
  'onGround',
  'hp',
  'framesAlive',
];

const HITBOX_FIELDS: (keyof WorldState['players'][number]['hitbox'])[] = [
  'active',
  'x',
  'y',
  'w',
  'h',
  'hitPlayer',
];

function collectWords(s: WorldState, out: number[]): void {
  out.push(s.frame, s.rngState, s.tickEvents);
  for (let pi = 0; pi < 2; pi++) {
    const p = s.players[pi];
    for (const k of PLAYER_FIELDS) out.push(p[k] as number);
    for (const k of HITBOX_FIELDS) out.push(p.hitbox[k] as number);
  }
}

export function hashState(s: WorldState): number {
  const words: number[] = [];
  collectWords(s, words);
  let h = 0x811c9dc5;
  for (const w of words) {
    const u = w >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= (u >>> (8 * i)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

/** 字段的默认归类：rngState 直接指向随机数问题，其余物理量默认物理问题 */
function defaultCategory(path: string): DivergenceReport['category'] {
  if (path === 'rngState' || path === 'tickEvents') return 'rng';
  return 'physics';
}

/**
 * 逐字段定位第一个分歧变量。
 * @param inputA / inputB 两端在该帧帧槽中实际保存的输入（可选）
 * @param intent 该帧的权威输入意图（可选）。帧槽输入一致但与意图不同，
 *        说明某端在输入采样/处理环节出错。
 */
export function findFirstMismatch(
  a: WorldState,
  b: WorldState,
  inputA?: [Input, Input],
  inputB?: [Input, Input],
  intent?: [Input, Input],
): Omit<DivergenceReport, 'frame'> | null {
  if (inputA && inputB) {
    for (let pi = 0; pi < 2; pi++) {
      if (inputA[pi].bits !== inputB[pi].bits) {
        return {
          firstMismatchPath: `inputs[${pi}].bits`,
          localValue: inputA[pi].bits,
          remoteValue: inputB[pi].bits,
          category: 'input',
          detail: `玩家${pi} 在该帧执行的输入不一致：本地 bits=${inputA[pi].bits}，对端 bits=${inputB[pi].bits}`,
        };
      }
    }
  }

  // 帧槽输入相同，但与权威意图不符：输入处理（吞键/边沿错误）导致的分歧
  if (inputA && intent) {
    for (let pi = 0; pi < 2; pi++) {
      if (inputA[pi].bits !== intent[pi].bits) {
        return {
          firstMismatchPath: `inputs[${pi}].bits`,
          localValue: inputA[pi].bits,
          remoteValue: intent[pi].bits,
          category: 'input',
          detail: `玩家${pi} 实际执行输入 bits=${inputA[pi].bits} 与权威意图 bits=${intent[pi].bits} 不符，检查输入采样/边沿处理`,
        };
      }
    }
  }

  if (a.rngState !== b.rngState) {
    return {
      firstMismatchPath: 'rngState',
      localValue: a.rngState,
      remoteValue: b.rngState,
      category: 'rng',
      detail: '随机数链状态不同：两边 LCG 调用次数或参数不一致，检查是否有分支导致 RNG 调用次数分叉',
    };
  }
  if (a.tickEvents !== b.tickEvents) {
    return {
      firstMismatchPath: 'tickEvents',
      localValue: a.tickEvents,
      remoteValue: b.tickEvents,
      category: 'rng',
      detail: '每帧事件计数不同：模拟步进路径发生分叉',
    };
  }

  for (let pi = 0; pi < 2; pi++) {
    const pa = a.players[pi];
    const pb = b.players[pi];
    for (const k of PLAYER_FIELDS) {
      const va = pa[k] as number;
      const vb = pb[k] as number;
      if (va !== vb) {
        return {
          firstMismatchPath: `players[${pi}].${k}`,
          localValue: va,
          remoteValue: vb,
          category: defaultCategory(k),
          detail: `玩家${pi} 的 ${k} 首次出现偏差（${va} vs ${vb}），输入与 RNG 均一致，问题出在物理/碰撞结算`,
        };
      }
    }
    for (const k of HITBOX_FIELDS) {
      const va = pa.hitbox[k] as number;
      const vb = pb.hitbox[k] as number;
      if (va !== vb) {
        return {
          firstMismatchPath: `players[${pi}].hitbox.${k}`,
          localValue: va,
          remoteValue: vb,
          category: 'physics',
          detail: `玩家${pi} 攻击判定盒 ${k} 不一致（${va} vs ${vb}），检查攻击帧时序与命中结算`,
        };
      }
    }
  }
  return null;
}
