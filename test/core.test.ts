import { describe, expect, it } from 'vitest';
import { divRound, mul32, trunc } from '../src/core/fixed';
import { createRng, nextInt, nextU32 } from '../src/core/rng';
import {
  ARENA_W,
  cloneState,
  createInitialState,
  emptyInputPair,
  step,
} from '../src/core/simulation';
import { findFirstMismatch, hashState } from '../src/core/hash';
import { INPUT_BITS, type Input, type WorldState } from '../src/core/types';

describe('定点整数工具', () => {
  it('trunc 向零截断且两端一致', () => {
    expect(trunc(7 / 3)).toBe(2);
    expect(trunc(-7 / 3)).toBe(-2);
    expect(divRound(7, 3)).toBe(2);
    expect(divRound(8, 3)).toBe(3);
    expect(divRound(-7, 3)).toBe(-2);
  });

  it('mul32 模拟 int32 溢出', () => {
    expect(mul32(0x7fffffff, 2)).toBe(-2);
  });
});

describe('确定性 RNG', () => {
  it('同种子序列完全一致', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    for (let i = 0; i < 1000; i++) {
      expect(nextU32(a)).toBe(nextU32(b));
    }
  });

  it('nextInt 落在 [0, bound)', () => {
    const r = createRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = nextInt(r, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });
});

describe('物理模拟确定性', () => {
  it('相同输入序列产生逐位相同状态', () => {
    const a = createInitialState();
    const b = createInitialState();
    const inputs: [Input, Input][] = [];
    for (let f = 0; f < 500; f++) {
      inputs.push([
        { bits: (f * 7) % 15 },
        { bits: (f * 11) % 15 },
      ]);
    }
    let prevA = emptyInputPair();
    let prevB = emptyInputPair();
    for (const inp of inputs) {
      step(a, prevA, inp);
      step(b, prevB, inp);
      prevA = inp;
      prevB = inp;
      expect(hashState(a)).toBe(hashState(b));
    }
    expect(a).toEqual(b);
  });

  it('角色不会越出场地且始终在地面上方', () => {
    const s = createInitialState();
    let prev = emptyInputPair();
    const right: Input = { bits: INPUT_BITS.RIGHT };
    const jump: Input = { bits: INPUT_BITS.JUMP };
    for (let f = 0; f < 2000; f++) {
      const inp: [Input, Input] = [
        f % 3 === 0 ? jump : right,
        { bits: INPUT_BITS.LEFT },
      ];
      step(s, prev, inp);
      prev = inp;
      for (const p of s.players) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w).toBeLessThanOrEqual(ARENA_W);
        expect(p.y + p.h).toBeLessThanOrEqual(300_000);
      }
    }
  });

  it('cloneState 是独立深拷贝', () => {
    const s = createInitialState();
    const c = cloneState(s);
    c.players[0].x += 123;
    expect(s.players[0].x).not.toBe(c.players[0].x);
  });
});

describe('分歧定位', () => {
  it('能找到首个写错的物理变量并归类 physics', () => {
    const a = createInitialState();
    const b = createInitialState();
    const inp = emptyInputPair();
    step(a, inp, inp);
    step(b, inp, inp);
    b.players[0].x += 1;
    const rep = findFirstMismatch(a, b, inp, inp);
    expect(rep).not.toBeNull();
    expect(rep!.category).toBe('physics');
    expect(rep!.firstMismatchPath).toBe('players[0].x');
  });

  it('输入不一致优先归类 input', () => {
    const a = createInitialState();
    const b = createInitialState();
    const ia: [Input, Input] = [{ bits: 1 }, { bits: 0 }];
    const ib: [Input, Input] = [{ bits: 0 }, { bits: 0 }];
    step(a, emptyInputPair(), ia);
    step(b, emptyInputPair(), ib);
    const rep = findFirstMismatch(a, b, ia, ib);
    expect(rep!.category).toBe('input');
  });

  it('rngState 不一致归类 rng', () => {
    const a = createInitialState();
    const b = createInitialState();
    const inp = emptyInputPair();
    step(a, inp, inp);
    step(b, inp, inp);
    b.rngState = (b.rngState + 1) | 0;
    const rep = findFirstMismatch(a, b);
    expect(rep!.category).toBe('rng');
    expect(rep!.firstMismatchPath).toBe('rngState');
  });
});

describe('全链路无浮点状态', () => {
  it('世界状态所有字段都是整数', () => {
    const s = createInitialState();
    const inp = emptyInputPair();
    for (let f = 0; f < 300; f++) step(s, inp, inp);
    const check = (v: unknown, path: string): void => {
      if (typeof v === 'number') {
        expect(Number.isInteger(v), `${path} 不是整数: ${v}`).toBe(true);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => check(x, `${path}[${i}]`));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          check(x, `${path}.${k}`);
        }
      }
    };
    check(s as unknown as WorldState, 'state');
  });
});
