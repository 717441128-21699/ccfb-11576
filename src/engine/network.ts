/**
 * 模拟网络链路（双向）。
 *
 * 不碰真实 socket：所有包在虚拟时钟上排队，按配置施加
 * 单向延迟、抖动、丢包、乱序。随机源独立于游戏 RNG，
 * 网络噪声绝不影响游戏内确定性随机链。
 *
 * 每个数据包携带最近若干帧的输入历史（冗余），即使单包丢失，
 * 对端也能从后续包里补齐输入——这是高丢包下不分歧的关键。
 */

import { createRng, nextInt, type Rng } from '../core/rng';
import type { Input, NetworkConfig, PlayerId } from '../core/types';

export interface NetPacket {
  from: PlayerId;
  seq: number;
  frame: number;
  input: Input;
  /** 累积确认：本端已收到的对端最高输入帧号 */
  ack: number;
  /** 所有尚未被对端 ACK 的输入（可靠重传，直到被确认） */
  history: { frame: number; input: Input }[];
}

interface ScheduledPacket {
  pkt: NetPacket;
  to: PlayerId;
  enqueuedAt: number;
  deliverAt: number;
}

export interface NetStats {
  sent: number;
  delivered: number;
  lost: number;
  reordered: number;
  /** 最近 64 个被投递包的实测单向延迟（毫秒） */
  latencySamples: number[];
}

export class NetworkLink {
  config: NetworkConfig;
  private rng: Rng;
  private queue: ScheduledPacket[] = [];
  private seq = 0;
  private now = 0;
  stats: Record<PlayerId, NetStats>;

  constructor(config: NetworkConfig, seed = 0x5eed_0000) {
    this.config = config;
    this.rng = createRng(seed);
    this.stats = [this.freshStats(), this.freshStats()];
  }

  private freshStats(): NetStats {
    return { sent: 0, delivered: 0, lost: 0, reordered: 0, latencySamples: [] };
  }

  reset(seed = 0x5eed_0000): void {
    this.rng = createRng(seed);
    this.queue.length = 0;
    this.seq = 0;
    this.now = 0;
    this.stats = [this.freshStats(), this.freshStats()];
  }

  send(
    from: PlayerId,
    frame: number,
    input: Input,
    ack: number,
    history: { frame: number; input: Input }[],
  ): void {
    const to: PlayerId = (1 - from) as PlayerId;
    const pkt: NetPacket = { from, seq: this.seq++, frame, input, ack, history };
    const st = this.stats[from];
    st.sent += 1;

    // 丢包：直接不排队
    if (nextInt(this.rng, 10_000) < this.config.lossRate * 10_000) {
      st.lost += 1;
      return;
    }

    const jitter = this.config.jitterMs > 0
      ? nextInt(this.rng, 2 * this.config.jitterMs + 1) - this.config.jitterMs
      : 0;
    const baseDelay = Math.max(0, this.config.latencyMs + jitter);

    // 乱序：部分包额外延迟 1~3 个帧时长，制造真正的后发先至
    let delay = baseDelay;
    if (nextInt(this.rng, 10_000) < this.config.reorderRate * 10_000) {
      delay += 16 + nextInt(this.rng, 3) * 16;
      st.reordered += 1;
    }

    this.queue.push({ pkt, to, enqueuedAt: this.now, deliverAt: this.now + delay });
  }

  /** 推进虚拟时间并投递到期包 */
  pump(nowMs: number): NetPacket[] {
    this.now = nowMs;
    const out: NetPacket[] = [];
    const remaining: ScheduledPacket[] = [];
    for (const sp of this.queue) {
      if (sp.deliverAt <= nowMs) {
        out.push(sp.pkt);
        const st = this.stats[sp.pkt.from];
        st.delivered += 1;
        st.latencySamples.push(sp.deliverAt - sp.enqueuedAt);
        if (st.latencySamples.length > 64) st.latencySamples.shift();
      } else {
        remaining.push(sp);
      }
    }
    this.queue = remaining;
    return out;
  }
}
