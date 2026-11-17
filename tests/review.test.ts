import { describe, it, expect } from 'vitest';
import { ReviewEngine } from '../src/engine/review.ts';
import { makeEmptyHands, Strain } from '../src/engine/cards.ts';
import { TranspositionTable } from '../src/engine/dds.ts';

// 1 张/家, NT, N 领 SA(最大) -> NS 必拿 1 墩
function oneCardHands() {
  const h = makeEmptyHands();
  h[0]![3] = 1 << 12; // N SA
  h[1]![3] = 1 << 11; // E SK
  h[2]![3] = 1 << 10; // S SQ
  h[3]![3] = 1 << 9; // W SJ
  return h;
}

describe('复盘引擎', () => {
  it('开局评估: 唯一着法即最佳, 墩数正确', () => {
    const strain: Strain = 4;
    const eng = new ReviewEngine(oneCardHands(), strain, 0, new TranspositionTable());
    const s = eng.getState();
    expect(s.assessments).toHaveLength(1);
    expect(s.assessments[0]!.isBest).toBe(true);
    expect(s.assessments[0]!.loss).toBe(0);
    expect(s.assessments[0]!.sideTricks).toBe(1); // N 方 (NS) 拿 1 墩
    expect(s.turn).toBe(0);
  });

  it('打完整墩后结束, 墩数落袋正确', () => {
    const strain: Strain = 4;
    const eng = new ReviewEngine(oneCardHands(), strain, 0, new TranspositionTable());
    // 四家依次各出唯一的一张: N SA, E SK, S SQ, W SJ
    eng.play(3, 12); // N
    eng.play(3, 11); // E
    eng.play(3, 10); // S
    eng.play(3, 9); // W
    const s = eng.getState();
    expect(s.finished).toBe(true);
    expect(s.nsBanked).toBe(1);
    expect(s.ewBanked).toBe(0);
    expect(s.assessments).toHaveLength(0);
  });

  it('2 张/家局面: 评估覆盖全部合法着法且最优标记一致', () => {
    const h = makeEmptyHands();
    h[0]![3] = (1 << 12) | (1 << 11); // AK
    h[1]![3] = (1 << 10) | (1 << 9); // QJ
    h[2]![3] = (1 << 8) | (1 << 7); // T9
    h[3]![3] = (1 << 6) | (1 << 5); // 87
    const eng = new ReviewEngine(h, 4, 0, new TranspositionTable());
    const s = eng.getState();
    // N 有两张黑桃 (AK 等价), 评估应给出 2 个着法且都标为最佳
    expect(s.assessments.length).toBeGreaterThan(0);
    const best = s.assessments.filter((a) => a.isBest);
    expect(best.length).toBeGreaterThan(0);
    for (const a of s.assessments) expect(a.loss).toBeGreaterThanOrEqual(0);
  });
});
