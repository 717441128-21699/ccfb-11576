/**
 * 牌的基础表示:
 * - 花色 0..3 = C, D, H, S; 定约 strain 0..4, 4 = NT
 * - 座位 0..3 = N, E, S W, 顺时针
 * - 每个花色用 13 位掩码, bit 0 = 2, bit 12 = A
 */

export const SUITS = ['C', 'D', 'H', 'S'] as const;
export type Suit = 0 | 1 | 2 | 3;

export const STRAINS = ['C', 'D', 'H', 'S', 'NT'] as const;
export type Strain = 0 | 1 | 2 | 3 | 4;
export const NT: Strain = 4;

export const SEATS = ['N', 'E', 'S', 'W'] as const;
export type Seat = 0 | 1 | 2 | 3;

export const RANK_CHARS = '23456789TJQKA';
export const RANK_MASK_13 = 0x1fff;

/** 每家每花色一个 13 位掩码, hands[seat][suit] */
export type Hands = number[][];

export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) & 3) as Seat;
}

export function partnerSeat(seat: Seat): Seat {
  return ((seat + 2) & 3) as Seat;
}

/** 0 = N/S 方, 1 = E/W 方 */
export function sideOf(seat: Seat): 0 | 1 {
  return (seat & 1) as 0 | 1;
}

export function rankBit(rank: number): number {
  return 1 << (rank - 2);
}

export function cardId(suit: Suit, rank: number): number {
  return suit * 13 + (rank - 2);
}

export function idSuit(id: number): Suit {
  return ((id / 13) | 0) as Suit;
}

export function idRank(id: number): number {
  return (id % 13) + 2;
}

export function cardName(id: number): string {
  return SUITS[idSuit(id)] + RANK_CHARS[idRank(id) - 2];
}

export function parseCard(text: string): number {
  const t = text.trim().toUpperCase();
  const si = SUITS.indexOf(t[0] as (typeof SUITS)[number]);
  if (si < 0) throw new Error(`无法识别的牌: ${text}`);
  const ri = RANK_CHARS.indexOf(t.slice(1));
  if (ri < 0) throw new Error(`无法识别的牌: ${text}`);
  return cardId(si as Suit, ri + 2);
}

export function makeEmptyHands(): Hands {
  return [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
}

export function cloneHands(hands: Hands): Hands {
  return hands.map((h) => h.slice());
}

export function countCards(hands: Hands): number {
  let n = 0;
  for (let p = 0; p < 4; p++) {
    for (let s = 0; s < 4; s++) {
      const mask = hands[p]?.[s] ?? 0;
      n += popcount(mask);
    }
  }
  return n;
}

export function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** 最高位的序号 (0..12), 空掩码返回 -1 */
export function highestBitIndex(mask: number): number {
  return 31 - Math.clz32(mask);
}

/** 最低位的序号 (0..12), 空掩码返回 -1 */
export function lowestBitIndex(mask: number): number {
  if (mask === 0) return -1;
  return 31 - Math.clz32(mask & -mask);
}

/** PBN 发牌串, 如 "N:63.AKQ987.A972.  ..." (四家, 点分隔花色 S.H.D.C) */
export function parsePBNDeal(text: string, forcedDealer?: Seat): Hands {
  const m = text.match(/^\s*([NESW])?\s*:\s*(.+)$/);
  if (!m) throw new Error('PBN 发牌串格式应为 "N:S.H.D.C S.H.D.C S.H.D.C S.H.D.C"');
  const first = (m[1] ? SEATS.indexOf(m[1] as (typeof SEATS)[number]) : forcedDealer ?? 0) as Seat;
  const blocks = m[2]!.trim().split(/\s+/).filter(Boolean);
  if (blocks.length !== 4) throw new Error('PBN 发牌串必须包含四家的牌');
  const hands = makeEmptyHands();
  for (let i = 0; i < 4; i++) {
    const seat = ((first + i) & 3) as Seat;
    const suitBlocks = blocks[i]!.split('.');
    if (suitBlocks.length !== 4) throw new Error(`第 ${SEATS[seat]} 家必须是 S.H.D.C 四个花色块`);
    for (let sb = 0; sb < 4; sb++) {
      const suit = (3 - sb) as Suit; // PBN 顺序 S H D C
      let mask = 0;
      for (const ch of suitBlocks[sb]!.toUpperCase()) {
        const ri = RANK_CHARS.indexOf(ch);
        if (ri < 0) throw new Error(`无法识别的牌张: ${ch}`);
        mask |= 1 << ri;
      }
      hands[seat]![suit] = mask;
    }
  }
  validateHands(hands);
  return hands;
}

export function validateHands(hands: Hands): void {
  const counts = [0, 0, 0, 0];
  const seen = [0, 0, 0, 0];
  for (let p = 0; p < 4; p++) {
    for (let s = 0; s < 4; s++) {
      const mask = hands[p]![s]!;
      if (mask & ~RANK_MASK_13) throw new Error(`${SEATS[p]} 家花色掩码越界`);
      if (seen[s]! & mask) throw new Error(`存在重复的牌: ${SUITS[s]} 花色`);
      seen[s]! |= mask;
      counts[p]! += popcount(mask);
    }
  }
  if (counts.some((c) => c !== 13)) throw new Error(`每家必须 13 张牌, 实际为 ${counts.join('/')}`);
  for (let s = 0; s < 4; s++) {
    if (seen[s] !== RANK_MASK_13) throw new Error(`${SUITS[s]} 花色 13 张牌不完整`);
  }
}

/** 转成 PBN 形式 (S.H.D.C), 方便展示与导出 */
export function toPBNDeal(hands: Hands, dealer: Seat = 0): string {
  const blocks: string[] = [];
  for (let i = 0; i < 4; i++) {
    const seat = ((dealer + i) & 3) as Seat;
    const parts: string[] = [];
    for (let s = 3; s >= 0; s--) {
      let str = '';
      let mask = hands[seat]![s]!;
      for (let r = 12; r >= 0; r--) if (mask & (1 << r)) str += RANK_CHARS[r];
      parts.push(str);
    }
    blocks.push(parts.join('.'));
  }
  return `${SEATS[dealer]}:${blocks.join(' ')}`;
}

/** 确定性伪随机 (mulberry32), 发牌/演示用 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机发一副完整的牌 */
export function dealRandomHands(rng: () => number): Hands {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  const hands = makeEmptyHands();
  for (let i = 0; i < 52; i++) {
    const seat = (i / 13 | 0) as Seat;
    const id = deck[i]!;
    hands[seat]![idSuit(id)]! |= 1 << (id % 13);
  }
  return hands;
}
