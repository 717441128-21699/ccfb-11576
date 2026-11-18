/**
 * 牌、花色、牌点的基础定义。
 *
 * 一副牌 52 张，card 编号 = suit * 13 + rank：
 *   suit: 0=♣ 草花 1=♦ 方块 2=♥ 红桃 3=♠ 黑桃 4=NT 无将（只用于定约/将牌入参）
 *   rank: 2..14，11=J 12=Q 13=K 14=A
 *
 * 一手/一墩牌用 16 位掩码表示（低 13 位为 2..A），一个花色一个掩码；
 * 四家各持 13 张，四个花色掩码即可完整描述一手牌。
 */

export const SUITS = [0, 1, 2, 3] as const;
export type Suit = 0 | 1 | 2 | 3;
/** 将牌花色 0..3，4 = 无将 */
export type Trump = 0 | 1 | 2 | 3 | 4;
export const NT = 4 as const;

export type Seat = 0 | 1 | 2 | 3;
/** 座位：0=N 北 1=E 东 2=S 南 3=W 西，顺时针排列 */
export const SEATS = [0, 1, 2, 3] as const;
export const SEAT_NAMES = ['N', 'E', 'S', 'W'] as const;
export const SEAT_NAMES_CN = ['北', '东', '南', '西'] as const;
export const SIDE_NS = 0;
export const SIDE_EW = 1;

export const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'] as const;
export const SUIT_NAMES_CN = ['草花', '方块', '红桃', '黑桃'] as const;
export const RANK_CHARS = '23456789TJQKA';

export function cardId(suit: Suit, rank: number): number {
  return suit * 13 + (rank - 2);
}
export function cardSuit(card: number): Suit {
  return Math.floor(card / 13) as Suit;
}
export function cardRank(card: number): number {
  return (card % 13) + 2;
}
export function cardName(card: number): string {
  return SUIT_SYMBOLS[cardSuit(card)] + RANK_CHARS[card % 13];
}

/** 同一花色下，rank 转掩码位 */
export function rankBit(rank: number): number {
  return 1 << (rank - 2);
}
/** 同花色掩码中最高牌点（无牌时返回 0） */
export function highestRank(mask: number): number {
  return mask === 0 ? 0 : 32 - Math.clz32(mask) + 1;
}
/** 某张牌在某花色掩码里是否存在 */
export function maskHas(mask: number, rank: number): boolean {
  return (mask & rankBit(rank)) !== 0;
}

export function seatSide(seat: Seat): 0 | 1 {
  return (seat & 1) as 0 | 1; // N/S 为偶数 0、2 -> 0；E/W 为奇数 1、3 -> 1
}
export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) & 3) as Seat;
}
export function partnerSeat(seat: Seat): Seat {
  return ((seat + 2) & 3) as Seat;
}

/** 遍历一个花色掩码里的所有牌点，从大到小 */
export function* ranksDesc(mask: number): Generator<number> {
  while (mask !== 0) {
    const r = 32 - Math.clz32(mask) + 1;
    yield r;
    mask &= mask - 1;
  }
}
/** 从小到大 */
export function* ranksAsc(mask: number): Generator<number> {
  while (mask !== 0) {
    const bit = mask & -mask;
    yield 32 - Math.clz32(bit) + 1;
    mask ^= bit;
  }
}
