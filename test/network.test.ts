import { describe, expect, it } from 'vitest';
import { NO_FAULTS } from '../src/core/faults';
import {
  DEFAULT_ROLLBACK,
  FRAME_MS,
  STRESS_NETWORK,
  Session,
} from '../src/engine/session';
import { runStress } from '../src/engine/stress';
import { INPUT_BITS } from '../src/core/types';

describe('回滚端点基础行为', () => {
  it('零网络损伤时两端始终同步且不需要回滚', () => {
    const session = new Session({
      network: { latencyMs: 0, jitterMs: 0, lossRate: 0, reorderRate: 0 },
      rollback: { ...DEFAULT_ROLLBACK },
      useAI: true,
    });
    for (let f = 0; f < 600; f++) session.stepFrame();
    expect(session.totalDivergences).toBe(0);
    expect(session.totals.rollbacks).toBe(0);
    expect(session.endpoints[0].state.frame).toBe(session.endpoints[1].state.frame);
  });

  it('卡顿端点恢复后能追上帧号且状态仍一致', () => {
    const session = new Session({
      network: { latencyMs: 100, jitterMs: 0, lossRate: 0, reorderRate: 0 },
      // 预测窗口只给 1 帧，100ms 单向延迟（约 6 帧）必然触发卡顿
      rollback: { inputDelayFrames: 1, interpolationFrames: 3, maxPredictedFrames: 1 },
      useAI: true,
    });
    let sawStall = false;
    for (let f = 0; f < 1500; f++) {
      session.stepFrame();
      if (session.stats[session.stats.length - 1].stalled) sawStall = true;
    }
    expect(sawStall).toBe(true);
    expect(session.totalDivergences).toBe(0);
    expect(session.endpoints[0].currentFrame).toBe(session.endpoints[1].currentFrame);
  });
});

describe('故障注入与分歧定位', () => {
  it('注入物理故障后能检出分歧并归类 physics', () => {
    const session = new Session(
      {
        network: { latencyMs: 20, jitterMs: 5, lossRate: 0, reorderRate: 0 },
        rollback: { ...DEFAULT_ROLLBACK },
        useAI: true,
      },
      [{ ...NO_FAULTS, physics: true }, { ...NO_FAULTS }],
    );
    for (let f = 0; f < 400; f++) session.stepFrame();
    expect(session.totalDivergences).toBeGreaterThan(0);
    expect(session.firstDivergence?.category).toBe('physics');
  });

  it('注入 RNG 故障后归类 rng', () => {
    const session = new Session(
      {
        network: { latencyMs: 20, jitterMs: 0, lossRate: 0, reorderRate: 0 },
        rollback: { ...DEFAULT_ROLLBACK },
        useAI: true,
      },
      [{ ...NO_FAULTS, rng: true }, { ...NO_FAULTS }],
    );
    for (let f = 0; f < 400; f++) session.stepFrame();
    expect(session.totalDivergences).toBeGreaterThan(0);
    expect(session.firstDivergence?.category).toBe('rng');
  });

  it('注入输入故障后归类 input', () => {
    // 手动按住攻击键，确保每个周期都有攻击输入可被吞
    const session = new Session(
      {
        network: { latencyMs: 20, jitterMs: 0, lossRate: 0, reorderRate: 0 },
        rollback: { ...DEFAULT_ROLLBACK },
        useAI: false,
      },
      [{ ...NO_FAULTS, input: true }, { ...NO_FAULTS }],
    );
    session.setIntent(0, { bits: INPUT_BITS.ATTACK });
    for (let f = 0; f < 500; f++) session.stepFrame();
    expect(session.totalDivergences).toBeGreaterThan(0);
    expect(session.firstDivergence?.category).toBe('input');
  });
});

describe('极限网络压测（验收标准）', () => {
  it(
    '200ms 延迟 + 50% 丢包连打 5 分钟（18000 帧）零分歧',
    async () => {
      const result = await runStress({
        network: { ...STRESS_NETWORK },
        rollback: { ...DEFAULT_ROLLBACK, maxPredictedFrames: 60 },
        frames: 18000,
        useAI: true,
      });
      expect(result.frames).toBe(18000);
      expect(result.elapsedSimMs).toBe(Math.round(18000 * FRAME_MS));
      expect(result.divergences).toBe(0);
      expect(result.passed).toBe(true);
    },
    60_000,
  );

  it('乱序 + 抖动 + 丢包组合下仍零分歧', async () => {
    const result = await runStress({
      network: { latencyMs: 120, jitterMs: 40, lossRate: 0.25, reorderRate: 0.2 },
      rollback: { ...DEFAULT_ROLLBACK },
      frames: 6000,
      useAI: true,
    });
    expect(result.divergences).toBe(0);
  });
});
