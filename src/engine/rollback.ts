/**
 * 回滚网络同步端点（GGPO 风格，单机双端点模拟）。
 *
 * 每个端点各自持有完整状态树与输入历史：
 *  - 本地输入按 inputDelay 帧延迟入栈；
 *  - 远端输入未到达时用空输入预测，先模拟再等修正；
 *  - 迟到的远端输入若落在已模拟帧上，回滚到该帧并按确定性模拟逐帧重算；
 *  - 超过 maxPredictedFrames 仍等不到远端输入时卡顿（stall），等输入到达后追帧。
 *
 * 本类不碰 DOM、不碰时钟，全部由外部 Session 驱动，便于在 Node 里压测。
 */

import { applyPostStep, corruptInput, type FaultFlags, NO_FAULTS } from '../core/faults';
import { hashState } from '../core/hash';
import { cloneState, createInitialState, step } from '../core/simulation';
import {
  EMPTY_INPUT,
  type Input,
  type PlayerId,
  type RollbackConfig,
  type RollbackEvent,
  type WorldState,
} from '../core/types';

function emptyPair(): [Input, Input] {
  return [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }];
}

export class RollbackEndpoint {
  readonly id: PlayerId;
  config: RollbackConfig;
  faults: FaultFlags;

  /** 已模拟到的最高帧号 */
  currentFrame = 0;
  /** 双方输入都已确认的最高帧号 */
  confirmedFrame = 0;
  /** 连续卡顿帧计数 */
  stalledFrames = 0;
  /** 本端点是否正处于卡顿状态 */
  stalled = false;

  /** 累计指标 */
  rollbackCount = 0;
  totalResimulatedFrames = 0;
  maxResimMs = 0;

  /** 待 Session 取走的回滚事件 */
  readonly events: RollbackEvent[] = [];

  /** frame -> 该帧使用的输入对（含预测填充） */
  private inputs = new Map<number, [Input, Input]>();
  /** frame -> 该帧【实际执行】的输入对（故障注入后可能与帧槽不同，仅供诊断） */
  private execInputs = new Map<number, [Input, Input]>();
  /** frame -> 该帧步进后的世界状态 */
  private states = new Map<number, WorldState>();
  private localKnown = new Set<number>();
  private remoteKnown = new Set<number>();
  private pendingRemote: { frame: number; input: Input }[] = [];
  private rollbackTo = -1;
  /**
   * 本地输入 FIFO。卡顿时模拟帧不出，但真实帧仍在产生输入，全部先排队。
   * 每项同时记录【产生该输入的真实帧号】：故障注入按真实帧号触发，
   * 回滚重算时必须复用同一个真实帧号，否则取模条件不再命中、故障被抹掉。
   */
  private localQueue: { schedFrame: number; realFrame: number; input: Input }[] = [];
  /** 模拟帧号 -> 真实帧号（故障注入按真实帧号触发，重算也要保持一致） */
  private realFrameOf = new Map<number, number>();

  constructor(id: PlayerId, config: RollbackConfig, faults: FaultFlags = { ...NO_FAULTS }) {
    this.id = id;
    this.config = config;
    this.faults = faults;
    this.reset();
  }

  reset(): void {
    this.currentFrame = 0;
    this.confirmedFrame = 0;
    this.stalledFrames = 0;
    this.stalled = false;
    this.rollbackCount = 0;
    this.totalResimulatedFrames = 0;
    this.maxResimMs = 0;
    this.events.length = 0;
    this.inputs.clear();
    this.execInputs.clear();
    this.states.clear();
    this.localKnown.clear();
    this.remoteKnown.clear();
    this.pendingRemote.length = 0;
    this.localQueue.length = 0;
    this.realFrameOf.clear();
    this.rollbackTo = -1;
    this.states.set(0, createInitialState());
  }

  /** 当前（最高帧）世界状态 */
  get state(): WorldState {
    return this.states.get(this.currentFrame)!;
  }

  get stateHash(): number {
    return hashState(this.state);
  }

  getStateAt(frame: number): WorldState | undefined {
    return this.states.get(frame);
  }

  getInputsAt(frame: number): [Input, Input] | undefined {
    return this.inputs.get(frame);
  }

  /** 诊断用：某帧实际执行的输入（含故障注入后的结果） */
  getExecInputsAt(frame: number): [Input, Input] | undefined {
    return this.execInputs.get(frame);
  }

  /**
   * 本地输入入队。
   * @param schedFrame 该输入应生效的全局模拟帧号（真实帧 + inputDelay）
   * @param realFrame  产生该输入的真实帧号（故障触发键，重算保持稳定）
   */
  addLocalInput(schedFrame: number, realFrame: number, input: Input): void {
    this.localQueue.push({ schedFrame, realFrame, input: { ...input } });
  }

  /** 收到网络对端的输入（可能迟到、可能重复） */
  pushRemoteInput(frame: number, input: Input): void {
    this.pendingRemote.push({ frame, input: { ...input } });
  }

  /**
   * 推进一次。
   * @param realFrame 当前会话真实帧号（故障注入按它触发）
   * 返回 true 表示成功模拟了一帧；false 表示预测窗口耗尽、进入卡顿。
   */
  tick(realFrame: number): boolean {
    // 输入处理必须先于卡顿判断：卡顿时远端输入恰恰在这些包里，
    // 若先判卡顿再 return，包永远进不了 remoteKnown，形成永久死锁。
    this.processRemotePackets();
    this.drainLocalQueue();

    const nextFrame = this.currentFrame + 1;
    if (!this.canPredict(nextFrame)) {
      this.stalled = true;
      this.stalledFrames += 1;
      return false;
    }
    this.stalled = false;

    if (this.rollbackTo !== -1) {
      this.doRollback();
    }

    if (!this.realFrameOf.has(nextFrame)) {
      this.realFrameOf.set(nextFrame, realFrame);
    }
    this.executeFrame(nextFrame, this.realFrameOf.get(nextFrame) ?? realFrame);
    this.advanceConfirmed();
    return true;
  }

  /** 弹出所有已到生效帧的本地输入，覆盖预测并登记需要回滚的旧帧 */
  private drainLocalQueue(): void {
    const nextFrame = this.currentFrame + 1;
    while (this.localQueue.length > 0 && this.localQueue[0].schedFrame <= nextFrame) {
      const item = this.localQueue.shift()!;
      // 记录该模拟帧对应的真实帧；已存在说明是回滚重算，保留首次映射，
      // 保证故障注入在原始执行与重算之间命中完全相同的真实帧号
      if (!this.realFrameOf.has(item.schedFrame)) {
        this.realFrameOf.set(item.schedFrame, item.realFrame);
      }
      const wasKnown = this.localKnown.has(item.schedFrame);
      const placed = this.inputs.get(item.schedFrame) ?? emptyPair();
      const changed = placed[this.id].bits !== item.input.bits;
      placed[this.id] = item.input;
      this.inputs.set(item.schedFrame, placed);
      this.localKnown.add(item.schedFrame);
      if (!wasKnown && changed && item.schedFrame <= this.currentFrame) {
        this.rollbackTo = this.rollbackTo === -1
          ? item.schedFrame
          : Math.min(this.rollbackTo, item.schedFrame);
      }
    }
  }

  /** 当前预测深度（未确认帧数） */
  get predictedFrames(): number {
    return this.currentFrame - this.confirmedFrame;
  }

  /** 该帧的本地 / 远端输入是否为真实到达（非预测填充） */
  isLocalKnown(frame: number): boolean {
    return this.localKnown.has(frame);
  }

  isRemoteKnown(frame: number): boolean {
    return this.remoteKnown.has(frame);
  }

  /** 对端已真实到达的最高输入帧号（用于给发送方回 ACK） */
  get remoteKnownMax(): number {
    let max = -1;
    for (const f of this.remoteKnown) if (f > max) max = f;
    return max;
  }

  // ------------------------------------------------------------------ //

  private get remoteId(): PlayerId {
    return (1 - this.id) as PlayerId;
  }

  private processRemotePackets(): void {
    for (const pkt of this.pendingRemote) {
      const alreadyKnown = this.remoteKnown.has(pkt.frame);
      // 真实到达的远端输入一律计入已知集合（未来帧同样成立）
      this.remoteKnown.add(pkt.frame);

      const existing = this.inputs.get(pkt.frame);
      const sameAsKnown =
        existing !== undefined && existing[this.remoteId].bits === pkt.input.bits;

      if (!sameAsKnown) {
        const pair = existing ?? emptyPair();
        pair[this.remoteId] = pkt.input;
        this.inputs.set(pkt.frame, pair);
      }

      // 只要是【新到达】且落在已模拟区间的输入，就登记回滚。
      // 不能只在值变化时回滚：该帧可能已基于更早的错误输入被模拟，
      // 新输入即便与占位值相同，也必须回到它这里把后续链路重算一遍。
      if (!alreadyKnown && pkt.frame <= this.currentFrame) {
        this.rollbackTo = this.rollbackTo === -1
          ? pkt.frame
          : Math.min(this.rollbackTo, pkt.frame);
      }
    }
    this.pendingRemote.length = 0;
  }

  private canPredict(frame: number): boolean {
    if (this.localKnown.has(frame) && this.remoteKnown.has(frame)) return true;
    // 任一侧输入缺失且超出预测窗口 -> 卡顿等待
    return frame - this.confirmedFrame <= this.config.maxPredictedFrames;
  }

  /** 取某帧输入对，缺失的输入用空输入预测并落盘（保证重算时拿到同一份） */
  private pairFor(frame: number): [Input, Input] {
    let pair = this.inputs.get(frame);
    if (!pair) {
      pair = emptyPair();
      this.inputs.set(frame, pair);
    }
    return pair;
  }

  private executeFrame(frame: number, realFrame: number): WorldState {
    const pair = this.pairFor(frame);
    // 故障注入：本端点对“自己玩家”的输入采样出错。
    // 故障结果按【模拟帧】持久化：首次执行计算一次，回滚重算复用同一份，
    // 保证故障稳定固化到该帧的状态树，而不是只影响一次性执行。
    let execPair = this.execInputs.get(frame);
    if (!execPair) {
      execPair = [{ ...pair[0] }, { ...pair[1] }];
      execPair[this.id] = corruptInput(pair[this.id], realFrame, this.faults);
      this.execInputs.set(frame, execPair);
    }
    const exec: [Input, Input] = [{ ...execPair[0] }, { ...execPair[1] }];

    const prevPair: [Input, Input] =
      frame === 0
        ? emptyPair()
        : this.inputs.get(frame - 1) ?? emptyPair();

    const prev: [Input, Input] = [{ ...prevPair[0] }, { ...prevPair[1] }];
    const next = cloneState(this.states.get(frame - 1)!);
    step(next, prev, exec);
    applyPostStep(next, realFrame, this.faults);
    this.states.set(frame, next);
    this.currentFrame = frame;
    return next;
  }

  private doRollback(): void {
    const target = this.rollbackTo;
    this.rollbackTo = -1;

    const checkpoint = this.states.get(target - 1);
    if (!checkpoint) {
      // 检查点已被裁剪（理论上不会发生），放弃回滚
      return;
    }
    const oldCurrent = this.currentFrame;
    const startedAt = performance.now();

    // 丢弃 target 及之后的所有状态与故障执行记录，从检查点重新推进
    for (const f of [...this.states.keys()]) {
      if (f >= target) this.states.delete(f);
    }
    for (const f of [...this.execInputs.keys()]) {
      if (f >= target) this.execInputs.delete(f);
    }
    this.currentFrame = target - 1;

    let count = 0;
    for (let f = target; f <= oldCurrent; f++) {
      const rf = this.realFrameOf.get(f) ?? f;
      this.executeFrame(f, rf);
      count++;
    }

    const resimMs = performance.now() - startedAt;
    this.rollbackCount += 1;
    this.totalResimulatedFrames += count;
    this.maxResimMs = Math.max(this.maxResimMs, resimMs);
    this.events.push({
      frame: oldCurrent,
      rollbackTo: target,
      framesResimulated: count,
      resimMs,
    });
  }

  private advanceConfirmed(): void {
    // 从已确认帧之后第一个“双方都有真实输入”的帧开始连续推进。
    // 输入延迟会让最初几个模拟帧没有真实输入（只有预测空输入），
    // 不能从 confirmedFrame+1 硬扫，否则首帧缺失会让确认链永远卡在 0。
    let f = this.confirmedFrame + 1;
    const gapLimit = f + this.config.inputDelayFrames + 4;
    while (f < gapLimit && !(this.localKnown.has(f) && this.remoteKnown.has(f))) {
      f += 1;
    }
    while (this.localKnown.has(f) && this.remoteKnown.has(f)) {
      this.confirmedFrame = f;
      f += 1;
    }
    // 不裁剪状态/输入历史：任何过去帧的输入修正都可能在深度丢包后
    // 迟到，回滚必须能一路回到帧 0 的根检查点完全重算，否则会从
    // “带预测输入生成的错误检查点”出发，让分歧永久累积。
    // 5 分钟 18000 帧的内存占用（每帧一个小状态树）实测仍在百 MB 内。
  }
}
