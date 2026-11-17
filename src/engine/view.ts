/**
 * 渲染插值视图。
 *
 * 回滚修正会让“权威状态”的位置突然跳变。显示层不直接画权威状态，
 * 而是维护一份渲染专用状态，每帧把平滑字段（位置/速度）朝目标
 * 线性逼近，用 interpolationFrames 帧把跳变抹平；其余离散字段
 * （朝向、血量、计时器、命中盒、RNG 等）立即对齐。
 *
 * 注意：插值只影响画面，绝不反馈进模拟。
 */

import { cloneState } from '../core/simulation';
import { trunc } from '../core/fixed';
import type { WorldState } from '../core/types';

const SMOOTH_FIELDS = ['x', 'y', 'vx', 'vy'] as const;

export class InterpolatedView {
  private display: WorldState;

  constructor(initial: WorldState) {
    this.display = cloneState(initial);
  }

  reset(initial: WorldState): void {
    this.display = cloneState(initial);
  }

  get state(): WorldState {
    return this.display;
  }

  /** 每渲染帧调用一次 */
  update(target: WorldState, interpolationFrames: number): void {
    const d = this.display;
    d.frame = target.frame;
    d.rngState = target.rngState;
    d.tickEvents = target.tickEvents;

    for (let pi = 0; pi < 2; pi++) {
      const dp = d.players[pi];
      const tp = target.players[pi];

      for (const field of SMOOTH_FIELDS) {
        const cur = dp[field];
        const goal = tp[field];
        if (interpolationFrames <= 0) {
          dp[field] = goal;
          continue;
        }
        const delta = goal - cur;
        if (delta === 0) continue;
        if (Math.abs(delta) <= interpolationFrames) {
          // 差距已经小于每帧步长，直接吸到目标，避免整数除法造成的永不到达
          dp[field] = goal;
        } else {
          dp[field] = cur + trunc(delta / interpolationFrames);
        }
      }

      // 离散/逻辑字段立即对齐
      dp.w = tp.w;
      dp.h = tp.h;
      dp.onGround = tp.onGround;
      dp.facing = tp.facing;
      dp.hp = tp.hp;
      dp.jumpBuffer = tp.jumpBuffer;
      dp.coyote = tp.coyote;
      dp.attackTimer = tp.attackTimer;
      dp.attackCooldown = tp.attackCooldown;
      dp.hurtTimer = tp.hurtTimer;
      dp.framesAlive = tp.framesAlive;
      dp.hitbox.active = tp.hitbox.active;
      dp.hitbox.w = tp.hitbox.w;
      dp.hitbox.h = tp.hitbox.h;
      dp.hitbox.hitPlayer = tp.hitbox.hitPlayer;
      // 命中盒坐标由渲染方依据显示位置 + 朝向推导，避免与平滑位置脱节
      dp.hitbox.x = tp.hitbox.x;
      dp.hitbox.y = tp.hitbox.y;
    }
  }
}
