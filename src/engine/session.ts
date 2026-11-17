/**
 * 会话编排器：两个 RollbackEndpoint + 一条 NetworkLink + 虚拟时钟。
 *
 * 职责：
 *  - 按固定步长（16.667ms 一帧）驱动两端，一帧 = 一个同步帧号；
 *  - 每帧收集本地输入（手动或内置 AI），做输入延迟入栈并组包发送（带冗余历史）；
 *  - 卡顿端点本帧不出帧，等远端输入到达后在后续帧追帧；
 *  - 同帧比对两端权威状态哈希，分歧时定位首个写错的变量并归类；
 *  - 记录每帧监视指标（回滚帧数、重算耗时、预测深度、卡顿）。
 */

import { type FaultFlags, NO_FAULTS } from '../core/faults';
import { findFirstMismatch, hashState } from '../core/hash';
import { createInitialState } from '../core/simulation';
import { InterpolatedView } from './view';
import { NetworkLink } from './network';
import { RollbackEndpoint } from './rollback';
import {
  EMPTY_INPUT,
  INPUT_BITS,
  type DivergenceReport,
  type Input,
  type NetworkConfig,
  type PlayerId,
  type RollbackConfig,
  type RollbackEvent,
} from '../core/types';

export const FRAME_MS = 1000 / 60;
/** 未确认输入缓冲的安全上限，超过则说明 ACK 链路异常（正常情况远小于此） */
const UNACKED_SAFETY_LIMIT = 2000;

/** 帧确定性哈希 PRNG（与游戏 RNG 无关，仅用于 AI 决策） */
function hash2(frame: number, salt: number): number {
  let h = Math.imul(frame ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export interface FrameStat {
  frame: number;
  /** 本帧发生回滚的端数（0/1/2） */
  rollbackCount: number;
  /** 本帧回滚重算的帧数（两端取较大值） */
  framesResimulated: number;
  /** 本帧重算耗时 ms（两端取较大值） */
  resimMs: number;
  /** 两端预测深度（较大值） */
  predicted: number;
  /** 本帧是否有端点卡顿 */
  stalled: boolean;
  /** 本帧比对时两端哈希是否一致 */
  inSync: boolean;
}

export interface SessionConfig {
  network: NetworkConfig;
  rollback: RollbackConfig;
  useAI: boolean;
}

export const DEFAULT_NETWORK: NetworkConfig = {
  latencyMs: 50,
  jitterMs: 20,
  lossRate: 0.02,
  reorderRate: 0.05,
};

export const DEFAULT_ROLLBACK: RollbackConfig = {
  inputDelayFrames: 2,
  interpolationFrames: 3,
  maxPredictedFrames: 30,
};

/** 200ms 延迟 + 50% 丢包的极限预设 */
export const STRESS_NETWORK: NetworkConfig = {
  latencyMs: 200,
  jitterMs: 30,
  lossRate: 0.5,
  reorderRate: 0.1,
};

export class Session {
  readonly endpoints: [RollbackEndpoint, RollbackEndpoint];
  readonly link: NetworkLink;
  readonly views: [InterpolatedView, InterpolatedView];
  config: SessionConfig;

  running = false;
  frame = 0;
  virtualNowMs = 0;
  totalDivergences = 0;
  firstDivergence: DivergenceReport | null = null;
  lastDivergence: DivergenceReport | null = null;
  readonly divergenceLog: DivergenceReport[] = [];

  /** 每帧一条，最多保留最近 600 条 */
  readonly stats: FrameStat[] = [];
  /** 每个端各自的逐帧预测深度（最近 600 帧），供监视页画两条曲线 */
  readonly depthHistory: [number[], number[]] = [[], []];
  /** 每个端各自的回滚事件流（最近 300 条） */
  readonly rollbackEvents: [RollbackEvent[], RollbackEvent[]] = [[], []];

  private intent: [Input, Input] = [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }];
  private intentLog = new Map<number, [Input, Input]>();
  /**
   * 每端尚未被对端 ACK 的本地输入（调度帧号 -> 输入）。
   * 每个出站包都携带全量未确认窗口，直到对端 ACK 才清理——
   * 这是 50% 丢包下“输入永不丢失、状态永不分歧”的可靠层。
   */
  private unacked: [
    Map<number, Input>,
    Map<number, Input>,
  ] = [new Map(), new Map()];

  constructor(config: SessionConfig, faults: [FaultFlags, FaultFlags] = [
    { ...NO_FAULTS }, { ...NO_FAULTS },
  ]) {
    this.config = config;
    this.link = new NetworkLink(config.network);
    this.endpoints = [
      new RollbackEndpoint(0, config.rollback, faults[0]),
      new RollbackEndpoint(1, config.rollback, faults[1]),
    ];
    const s0 = createInitialState();
    this.views = [new InterpolatedView(s0), new InterpolatedView(s0)];
  }

  reset(): void {
    this.frame = 0;
    this.virtualNowMs = 0;
    this.totalDivergences = 0;
    this.firstDivergence = null;
    this.lastDivergence = null;
    this.lastCheckedFrame = 0;
    this.divergenceLog.length = 0;
    this.stats.length = 0;
    this.depthHistory[0].length = 0;
    this.depthHistory[1].length = 0;
    this.rollbackEvents[0].length = 0;
    this.rollbackEvents[1].length = 0;
    this.intentLog.clear();
    this.unacked = [new Map(), new Map()];
    this.intent = [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }];
    this.link.reset();
    for (const ep of this.endpoints) ep.reset();
    const s0 = createInitialState();
    this.views[0].reset(s0);
    this.views[1].reset(s0);
  }

  /** 手动模式下设置某个玩家当前按住的输入位图 */
  setIntent(id: PlayerId, input: Input): void {
    this.intent[id] = { ...input };
  }

  /**
   * 某模拟帧上、按输入延迟调度后的权威输入意图（未经端点故障污染）。
   * 同步检查用它判断端点是否在“输入处理”环节写错。
   */
  scheduledIntentAt(frame: number): [Input, Input] | undefined {
    // 两端 inputDelay 当前共用同一配置；保留按端查询的形态便于以后分化
    const delay = this.config.rollback.inputDelayFrames;
    const realFrame = frame - delay;
    const logged = this.intentLog.get(realFrame);
    return logged ? [{ ...logged[0] }, { ...logged[1] }] : undefined;
  }

  /**
   * 扫描 [1..checkTop] 内两端共有的模拟帧，定位首个分歧。
   * 每个真实帧只从最近检查点往后扫，避免全量 O(n²) 哈希。
   * 返回首个分歧帧号，0 表示无分歧。
   */
  private lastCheckedFrame = 0;

  private scanForDivergence(checkTop: number): number {
    const e0 = this.endpoints[0];
    const e1 = this.endpoints[1];
    const start = Math.max(1, this.lastCheckedFrame + 1);
    for (let frame = start; frame <= checkTop; frame++) {
      const s0 = e0.getStateAt(frame);
      const s1 = e1.getStateAt(frame);
      if (!s0 || !s1) continue;
      if (hashState(s0) === hashState(s1)) {
        this.lastCheckedFrame = frame;
        continue;
      }
      this.totalDivergences += 1;
      const execA = e0.getExecInputsAt(frame);
      const execB = e1.getExecInputsAt(frame);
      const intent = this.scheduledIntentAt(frame);
      const found = findFirstMismatch(s0, s1, execA, execB, intent);
      if (found) {
        const report: DivergenceReport = { frame, ...found };
        this.lastDivergence = report;
        this.firstDivergence ??= report;
        this.divergenceLog.push(report);
        if (this.divergenceLog.length > 50) this.divergenceLog.shift();
      }
      this.lastCheckedFrame = frame;
      return frame;
    }
    return 0;
  }

  private localInputFor(id: PlayerId): Input {
    if (this.config.useAI) return this.aiInput(id, this.frame);
    return { ...this.intent[id] };
  }

  /**
   * 帧确定性 AI：只依赖 (玩家, 帧号) 与该端点当前状态。
   *
   * 关键：不能用任何按“调用次数”推进的随机源——某端卡顿追帧时
   * 同一真实帧会执行多个模拟帧，调用次数型 RNG 会让两端错位。
   * 这里用帧号做种子的纯哈希 PRNG，同一模拟帧号在任何时刻、
   * 任何端点上生成的输入都完全一致。
   */
  private aiInput(id: PlayerId, frame: number): Input {
    const ep = this.endpoints[id];
    const me = ep.state.players[id];
    const foe = ep.state.players[1 - id];
    let bits = 0;
    if (foe.x < me.x) bits |= INPUT_BITS.LEFT;
    else if (foe.x > me.x) bits |= INPUT_BITS.RIGHT;

    const h1 = hash2(frame + 1, id * 7919 + 1);
    const r1 = h1 % 100;
    if (r1 < 10) bits |= INPUT_BITS.JUMP;
    const h2 = hash2(frame + 1, id * 104729 + 7);
    if (h2 % 100 >= 88) bits |= INPUT_BITS.ATTACK;
    return { bits };
  }

  /** 推进到指定虚拟时间，内部按固定步长切帧；返回实际执行的帧数 */
  advance(targetMs: number): number {
    let executed = 0;
    // 单帧最多补 8 帧，防止长时间卡顿后无限制追帧
    let guard = 8;
    while (this.virtualNowMs + FRAME_MS <= targetMs && guard-- > 0) {
      this.stepFrame();
      executed += 1;
    }
    return executed;
  }

  /** 推进一个固定步长帧 */
  stepFrame(): void {
    this.frame += 1;
    // 先推进虚拟时钟：本帧组的包按“现在”入队，pump 也按“现在”投递，
    // 否则 pump 看到的永远是上一帧时刻，小于一帧时长的延迟永远不触发
    this.virtualNowMs += FRAME_MS;
    const f = this.frame;

    // 1) 生成本帧本地输入并记录
    const pair: [Input, Input] = [this.localInputFor(0), this.localInputFor(1)];
    this.intentLog.set(f, [{ ...pair[0] }, { ...pair[1] }]);
    if (this.intentLog.size > 400) {
      const oldest = Math.min(...this.intentLog.keys());
      this.intentLog.delete(oldest);
    }

    // 2) 输入延迟调度 + 可靠组包。
    //    生效帧 = 全局真实帧 + inputDelay，两端帧号定义完全一致。
    for (const id of [0, 1] as const) {
      const ep = this.endpoints[id];
      const schedFrame = f + ep.config.inputDelayFrames;
      ep.addLocalInput(schedFrame, f, pair[id]);

      // 放入未确认缓冲区，收到对端 ACK 前每个包都会重传它
      this.unacked[id].set(schedFrame, { ...pair[id] });
      if (this.unacked[id].size > UNACKED_SAFETY_LIMIT) {
        // 安全护栏：正常 ACK 下不会触及；若触及说明对端长时间收不到任何包
        const oldest = Math.min(...this.unacked[id].keys());
        this.unacked[id].delete(oldest);
      }
      const history = [...this.unacked[id].entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([frame, input]) => ({ frame, input: { ...input } }));
      const ack = ep.remoteKnownMax;
      this.link.send(id, schedFrame, pair[id], ack, history);
    }

    // 3) 网络投递：补全输入并按 ACK 清理本端未确认缓冲区
    const packets = this.link.pump(this.virtualNowMs);
    for (const pkt of packets) {
      const receiver = this.endpoints[1 - pkt.from];
      receiver.pushRemoteInput(pkt.frame, pkt.input);
      for (const h of pkt.history) receiver.pushRemoteInput(h.frame, h.input);
      // 发送方 pkt.from 据此得知对端已收到哪些自己的输入，清理重传缓冲
      const senderBuf = this.unacked[pkt.from];
      for (const frame of [...senderBuf.keys()]) {
        if (frame <= pkt.ack) senderBuf.delete(frame);
      }
    }

    // 4) 两端各自步进。
    //    每个真实帧每个端点必须 tick 一次——即使已经“落后”也要 tick，
    //    否则网络输入永远没有机会被 processRemotePackets 处理，造成永久死等。
    //    tick 内部决定推进一帧还是卡顿；恢复后多个真实帧的连续 tick
    //    会自然把落后的帧追回来（输入按全局帧号调度，追帧不会错槽）。
    for (const id of [0, 1] as const) {
      this.endpoints[id].tick(this.frame);
    }

    // 5) 收走回滚事件
    let rollbackCount = 0;
    let framesResimulated = 0;
    let resimMs = 0;
    for (const id of [0, 1] as const) {
      const evs = this.endpoints[id].events;
      if (evs.length) {
        rollbackCount += evs.length;
        for (const ev of evs) {
          this.rollbackEvents[id].push(ev);
          framesResimulated = Math.max(framesResimulated, ev.framesResimulated);
          resimMs = Math.max(resimMs, ev.resimMs);
        }
        if (this.rollbackEvents[id].length > 300) {
          this.rollbackEvents[id].splice(0, this.rollbackEvents[id].length - 300);
        }
        evs.length = 0;
      }
    }

    const stalled = this.endpoints[0].stalled || this.endpoints[1].stalled;
    const predicted = Math.max(
      this.endpoints[0].predictedFrames,
      this.endpoints[1].predictedFrames,
    );

    // 6) 同步检查：只扫描两端【双方输入都已真实确认】的帧。
    //    预测帧本就允许暂时不同（等修正），不能作为分歧；
    //    共同确认帧以内的权威状态必须逐位一致。
    let inSync = true;
    const e0 = this.endpoints[0];
    const e1 = this.endpoints[1];
    const checkTop = Math.min(e0.confirmedFrame, e1.confirmedFrame);
    const divergedAt = this.scanForDivergence(checkTop);
    if (divergedAt > 0) inSync = false;

    this.stats.push({
      frame: f,
      rollbackCount,
      framesResimulated,
      resimMs,
      predicted,
      stalled,
      inSync,
    });
    if (this.stats.length > 600) this.stats.shift();
    for (const id of [0, 1] as const) {
      this.depthHistory[id].push(this.endpoints[id].predictedFrames);
      if (this.depthHistory[id].length > 600) this.depthHistory[id].shift();
    }

    // 7) 渲染插值视图（无论该端是否出帧都更新，参数热更新即时生效）
    for (const id of [0, 1] as const) {
      this.views[id].update(this.endpoints[id].state, this.config.rollback.interpolationFrames);
    }
  }

  /** 汇总指标，供监视页展示 */
  get totals() {
    const rb0 = this.endpoints[0].rollbackCount;
    const rb1 = this.endpoints[1].rollbackCount;
    const resim0 = this.endpoints[0].totalResimulatedFrames;
    const resim1 = this.endpoints[1].totalResimulatedFrames;
    const stallTotal =
      this.endpoints[0].stalledFrames + this.endpoints[1].stalledFrames;
    return {
      rollbacks: rb0 + rb1,
      resimulated: resim0 + resim1,
      maxResimMs: Math.max(this.endpoints[0].maxResimMs, this.endpoints[1].maxResimMs),
      stallFrames: stallTotal,
    };
  }
}
