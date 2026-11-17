/**
 * 定点整数运算工具。
 *
 * 整个模拟世界只用整数：1 格(网格单位)= 1/1000 像素，所有坐标、速度、
 * 尺寸都以千分之一像素为单位。JS 位运算会截成 int32，所以这里统一用
 * Math.imul / 显式取整，禁止浮点参与任何状态计算，保证两端逐位一致。
 */

export const GRID = 1000;

/** 向零取整（C 语言风格的整数除法截断） */
export function trunc(n: number): number {
  return n >= 0 ? Math.floor(n) : Math.ceil(n);
}

/** 向下取整的整数除法 */
export function divFloor(a: number, b: number): number {
  return Math.floor(a / b);
}

/** 整数 a 除以正整数 d 的四舍五入结果（对称四舍五入，两端一致） */
export function divRound(a: number, d: number): number {
  return trunc((a + (a >= 0 ? (d >> 1) : -(d >> 1))) / d);
}

/** 有符号的 32 位乘法（模拟 int32 溢出） */
export function mul32(a: number, b: number): number {
  return Math.imul(a, b);
}

/** 把数值夹在 [lo, hi] 整数区间内 */
export function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 带舍入的定点缩放：v * num / den，全部在整数域完成。
 * 用于插值渲染之外的任何“比例”计算。
 */
export function scaleRound(v: number, num: number, den: number): number {
  return divRound(Math.imul(v, num), den);
}

export function absInt(v: number): number {
  return v < 0 ? -v : v;
}
