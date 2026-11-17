/**
 * 确定性物理模拟：所有运算都在整数网格上进行（1 单位 = 1/1000 像素）。
 *
 * 铁律：
 *  1. 本文件禁止出现浮点字面量参与状态运算、禁止 Math.random / Date；
 *  2. 相同 (state, prevInput, input) 必须逐位产生相同 state；
 *  3. 随机数只允许通过 state.rngState 驱动的 LCG 获取。
 */

import { clampInt } from './fixed';
import { createRng, nextInt, nextU32 } from './rng';
import {
  EMPTY_INPUT,
  INPUT_BITS,
  type Input,
  type PlayerId,
  type PlayerState,
  type WorldState,
} from './types';

// ---- 世界常量（整数，单位：千分之一像素；速度 = 千分之一像素/帧） ----
export const ARENA_W = 640_000;
export const ARENA_H = 360_000;
export const GROUND_Y = 300_000; // 地面上边缘

export const PLAYER_W = 26_000;
export const PLAYER_H = 42_000;

const MAX_RUN_SPEED = 9_000;
const ACCEL = 1_600;
const FRICTION = 1_400;
const GRAVITY = 1_900;
const MAX_FALL = 32_000;
const JUMP_VELOCITY = -24_000;
const COYOTE_FRAMES = 6;
const JUMP_BUFFER_FRAMES = 6;

const ATTACK_DURATION = 12; // 攻击动作总帧数
const ATTACK_ACTIVE_START = 4;
const ATTACK_ACTIVE_END = 8;
const ATTACK_COOLDOWN = 20;
const HITBOX_W = 30_000;
const HITBOX_H = 22_000;
const HIT_DAMAGE = 7;
const CRIT_DAMAGE = 14;
const KNOCKBACK_X = 14_000;
const KNOCKBACK_Y = -8_000;
const HURT_FRAMES = 10;
const MAX_HP = 100;

const RNG_SEED = 0xc0ffee;

export function createInitialState(): WorldState {
  const make = (id: PlayerId): PlayerState => ({
    x: id === 0 ? 120_000 : ARENA_W - 120_000 - PLAYER_W,
    y: GROUND_Y - PLAYER_H,
    vx: 0,
    vy: 0,
    w: PLAYER_W,
    h: PLAYER_H,
    onGround: 1,
    facing: id === 0 ? 1 : -1,
    hp: MAX_HP,
    jumpBuffer: 0,
    coyote: 0,
    attackTimer: 0,
    attackCooldown: 0,
    hitbox: { active: 0, x: 0, y: 0, w: HITBOX_W, h: HITBOX_H, hitPlayer: -1 },
    hurtTimer: 0,
    framesAlive: 0,
  });
  return {
    frame: 0,
    players: [make(0), make(1)],
    rngState: createRng(RNG_SEED).state,
    tickEvents: 0,
  };
}

function pressed(now: Input, prev: Input, bit: number): boolean {
  return (now.bits & bit) !== 0 && (prev.bits & bit) === 0;
}

function aabbOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** 玩家之间的整数 AABB 推挤解算，沿最小穿透轴分开 */
function resolvePlayerCollision(p: PlayerState, q: PlayerState): void {
  if (!aabbOverlap(p.x, p.y, p.w, p.h, q.x, q.y, q.w, q.h)) return;
  const overlapLeft = p.x + p.w - q.x; // p 在左
  const overlapRight = q.x + q.w - p.x;
  const overlapTop = p.y + p.h - q.y;
  const overlapBottom = q.y + q.h - p.y;
  const minX = Math.min(overlapLeft, overlapRight);
  const minY = Math.min(overlapTop, overlapBottom);

  if (minX < minY) {
    if (overlapLeft <= overlapRight) {
      p.x -= overlapLeft;
      if (p.vx > 0) p.vx = 0;
      if (q.vx < 0) q.vx = 0;
    } else {
      p.x += overlapRight;
      if (p.vx < 0) p.vx = 0;
      if (q.vx > 0) q.vx = 0;
    }
  } else {
    if (overlapTop <= overlapBottom) {
      p.y -= overlapTop;
      if (p.vy > 0) p.vy = 0;
      if (q.vy < 0) q.vy = 0;
    } else {
      p.y += overlapBottom;
      if (p.vy < 0) p.vy = 0;
      if (q.vy > 0) q.vy = 0;
    }
  }
}

function stepPlayer(
  p: PlayerState,
  input: Input,
  prev: Input,
): void {
  // 计时器递减
  if (p.attackCooldown > 0) p.attackCooldown -= 1;
  if (p.attackTimer > 0) p.attackTimer -= 1;
  if (p.hurtTimer > 0) p.hurtTimer -= 1;

  const locked = p.hurtTimer > 0;
  const left = !locked && (input.bits & INPUT_BITS.LEFT) !== 0;
  const right = !locked && (input.bits & INPUT_BITS.RIGHT) !== 0;

  // 水平移动
  if (left && !right) {
    p.vx = Math.max(p.vx - ACCEL, -MAX_RUN_SPEED);
    p.facing = -1;
  } else if (right && !left) {
    p.vx = Math.min(p.vx + ACCEL, MAX_RUN_SPEED);
    p.facing = 1;
  } else if (p.vx > 0) {
    p.vx = Math.max(0, p.vx - FRICTION);
  } else if (p.vx < 0) {
    p.vx = Math.min(0, p.vx + FRICTION);
  }

  // 跳跃缓冲（边沿触发）
  if (!locked && pressed(input, prev, INPUT_BITS.JUMP)) {
    p.jumpBuffer = JUMP_BUFFER_FRAMES;
  } else if (p.jumpBuffer > 0) {
    p.jumpBuffer -= 1;
  }

  // 土狼时间
  if (p.onGround === 1) {
    p.coyote = COYOTE_FRAMES;
  } else if (p.coyote > 0) {
    p.coyote -= 1;
  }

  if (!locked && p.jumpBuffer > 0 && (p.onGround === 1 || p.coyote > 0)) {
    p.vy = JUMP_VELOCITY;
    p.onGround = 0;
    p.coyote = 0;
    p.jumpBuffer = 0;
  }

  // 攻击启动
  if (
    !locked &&
    pressed(input, prev, INPUT_BITS.ATTACK) &&
    p.attackTimer === 0 &&
    p.attackCooldown === 0
  ) {
    p.attackTimer = ATTACK_DURATION;
    p.attackCooldown = ATTACK_COOLDOWN;
    p.hitbox.hitPlayer = -1;
  }

  // 重力
  p.vy = Math.min(p.vy + GRAVITY, MAX_FALL);

  // 积分 + 墙体
  p.x = clampInt(p.x + p.vx, 0, ARENA_W - p.w);

  // 积分 + 地面
  p.y += p.vy;
  p.onGround = 0;
  if (p.y + p.h >= GROUND_Y) {
    p.y = GROUND_Y - p.h;
    p.vy = 0;
    p.onGround = 1;
  }

  // 攻击命中盒位置（朝面向方向伸出）
  const elapsed = ATTACK_DURATION - p.attackTimer;
  if (p.attackTimer > 0 && elapsed >= ATTACK_ACTIVE_START && elapsed <= ATTACK_ACTIVE_END) {
    p.hitbox.active = 1;
    p.hitbox.x = p.facing === 1 ? p.x + p.w - 4_000 : p.x - HITBOX_W + 4_000;
    p.hitbox.y = p.y + 6_000;
  } else {
    p.hitbox.active = 0;
  }

  p.framesAlive += 1;
}

/** 攻击命中检测与伤害结算（随机暴击由全局 RNG 驱动） */
function resolveAttacks(state: WorldState): void {
  for (const id of [0, 1] as const) {
    const attacker = state.players[id];
    const target = state.players[1 - id];
    const hb = attacker.hitbox;
    if (hb.active !== 1 || hb.hitPlayer !== -1) continue;
    if (target.hurtTimer > 0 || target.hp <= 0) continue;
    if (!aabbOverlap(hb.x, hb.y, hb.w, hb.h, target.x, target.y, target.w, target.h)) continue;

    const rng = { state: state.rngState };
    const crit = nextInt(rng, 100) < 25;
    state.rngState = rng.state;
    target.hp = Math.max(0, target.hp - (crit ? CRIT_DAMAGE : HIT_DAMAGE));
    target.vx = attacker.facing * KNOCKBACK_X;
    target.vy = KNOCKBACK_Y;
    target.onGround = 0;
    target.hurtTimer = HURT_FRAMES;
    hb.hitPlayer = 1 - id;
  }
}

/**
 * 推进一帧。纯函数式更新（原地修改传入的 state，但不读任何外部状态）。
 * @param prev 上一帧输入，首帧传 EMPTY_INPUT
 */
export function step(state: WorldState, prev: [Input, Input], inputs: [Input, Input]): WorldState {
  state.frame += 1;

  stepPlayer(state.players[0], inputs[0], prev[0]);
  stepPlayer(state.players[1], inputs[1], prev[1]);

  resolvePlayerCollision(state.players[0], state.players[1]);
  resolveAttacks(state);

  // 每帧无条件推进一次 RNG：环境阵风（小概率、小幅水平扰动）。
  // 固定调用次数保证即使双方都挂机，随机数链也逐帧对齐。
  const rng = { state: state.rngState };
  const roll = nextU32(rng) % 200;
  state.rngState = rng.state;
  if (roll < 2) {
    const gust = (nextU32(rng) % 3) - 1; // -1, 0, 1
    state.rngState = rng.state;
    for (const p of state.players) {
      p.vx = clampInt(p.vx + gust * 600, -MAX_RUN_SPEED, MAX_RUN_SPEED);
    }
  }

  state.tickEvents += 1;
  return state;
}

/** 深拷贝世界状态（回滚时用于保存检查点） */
export function cloneState(s: WorldState): WorldState {
  return structuredClone(s);
}

/** 供测试用：空输入元组 */
export function emptyInputPair(): [Input, Input] {
  return [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }];
}
