/**
 * 模拟层共享类型。所有参与同步的状态都必须是可结构化克隆的纯数据，
 * 且只能由整数（或定长整数数组）构成——禁止浮点、对象引用、函数。
 */

/** 玩家编号 */
export type PlayerId = 0 | 1;

/**
 * 单帧输入（位图）。两端输入结构完全一致，缺失输入时回滚层用
 * 预测输入（默认零输入）填充。
 */
export interface Input {
  /** bit0: 左  bit1: 右  bit2: 跳  bit3: 攻击 */
  bits: number;
}

export const INPUT_BITS = {
  LEFT: 1 << 0,
  RIGHT: 1 << 1,
  JUMP: 1 << 2,
  ATTACK: 1 << 3,
} as const;

export function inputEquals(a: Input, b: Input): boolean {
  return a.bits === b.bits;
}

export const EMPTY_INPUT: Input = { bits: 0 };

/** 攻击判定盒（命中盒），与角色盒分离，方便展示碰撞箱 */
export interface Hitbox {
  active: 0 | 1;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 本次攻击已命中的玩家，-1 表示尚未命中；防止一帧外的持续判定重复扣血 */
  hitPlayer: number;
}

/** 单个玩家的完整状态，全部为整数（单位：千分之一像素 / 帧） */
export interface PlayerState {
  x: number;
  y: number;
  /** 水平速度，单位：千分之一像素 / 帧 */
  vx: number;
  /** 垂直速度，单位：千分之一像素 / 帧 */
  vy: number;
  w: number;
  h: number;
  onGround: 0 | 1;
  facing: 1 | -1;
  hp: number;
  /** 跳跃缓冲：按下跳跃后保留若干帧，落地自动起跳 */
  jumpBuffer: number;
  /** 起跳后“土狼时间”内仍允许跳 */
  coyote: number;
  /** 攻击动作剩余帧；>0 时处于攻击中 */
  attackTimer: number;
  /** 攻击冷却剩余帧 */
  attackCooldown: number;
  hitbox: Hitbox;
  /** 受击硬直剩余帧 */
  hurtTimer: number;
  /** 累计统计（也是同步状态，分歧时参与比对） */
  framesAlive: number;
}

/**
 * 完整世界状态。frame 是该状态对应的帧号；rngState 让随机事件
 * （比如随机扰动）也严格确定。
 */
export interface WorldState {
  frame: number;
  players: [PlayerState, PlayerState];
  rngState: number;
  /** 每帧 +1 的单调事件计数，用来演示“随机数分歧”定位 */
  tickEvents: number;
}

/** 单帧输入包：帧号 + 两个玩家的输入 */
export interface FrameInput {
  frame: number;
  inputs: [Input, Input];
}

/** 网络配置（仅影响传输层，不参与状态哈希） */
export interface NetworkConfig {
  /** 单向基础延迟（毫秒） */
  latencyMs: number;
  /** 抖动幅度（毫秒），实际延迟在 base±jitter 内均匀分布 */
  jitterMs: number;
  /** 丢包率 0..1 */
  lossRate: number;
  /** 乱序率 0..1：命中的包被额外延后一个随机时长 */
  reorderRate: number;
}

/** 回滚 / 同步参数 */
export interface RollbackConfig {
  /** 输入延迟帧数（本地输入先缓存 N 帧再执行） */
  inputDelayFrames: number;
  /** 渲染插值帧数：回滚导致的画面跳变用 N 帧抹平 */
  interpolationFrames: number;
  /** 最大回滚窗口，超过则丢弃最旧的已确认帧 */
  maxPredictedFrames: number;
}

/** 一次回滚事件的监视记录 */
export interface RollbackEvent {
  /** 触发回滚的当前帧 */
  frame: number;
  /** 回退到的帧号 */
  rollbackTo: number;
  /** 回滚并重算的帧数 */
  framesResimulated: number;
  /** 重算耗时（毫秒，performance.now 测量，仅监视用） */
  resimMs: number;
}

/** 同步检查定位结果 */
export interface DivergenceReport {
  frame: number;
  /** 第一个出现不一致的状态变量路径，例如 players.0.x */
  firstMismatchPath: string;
  /** 两端在该变量上的值 */
  localValue: number;
  remoteValue: number;
  /** 归类原因 */
  category: 'physics' | 'rng' | 'input' | 'unknown';
  detail: string;
}
