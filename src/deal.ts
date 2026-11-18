import {
  type Seat,
  type Suit,
  SUITS,
  SEATS,
  SEAT_NAMES,
  nextSeat,
  cardId,
  rankBit,
} from './cards.js';

/**
 * 一手牌 = 四个花色的 13 位掩码。hands[seat][suit] = 该座位该花色持牌掩码。
 * 用普通数字数组而不是 TypedArray，方便整体拷贝/交换，单牌操作也足够快。
 */
export type Hand = [number, number, number, number];
export type Deal = [Hand, Hand, Hand, Hand]; // index = Seat

export function emptyHand(): Hand {
  return [0, 0, 0, 0];
}

export function cloneDeal(d: Deal): Deal {
  return [
    [...d[0]] as Hand,
    [...d[1]] as Hand,
    [...d[2]] as Hand,
    [...d[3]] as Hand,
  ];
}

export function dealCardCount(d: Deal): number {
  let n = 0;
  for (const h of d) for (const m of h) n += bitCount(m);
  return n;
}

export function bitCount(mask: number): number {
  let n = 0;
  while (mask !== 0) {
    mask &= mask - 1;
    n++;
  }
  return n;
}

export function handHasCard(d: Deal, seat: Seat, card: number): boolean {
  const suit = Math.floor(card / 13) as Suit;
  const rank = (card % 13) + 2;
  return (d[seat][suit] & rankBit(rank)) !== 0;
}

export function removeCard(d: Deal, seat: Seat, card: number): void {
  const suit = Math.floor(card / 13) as Suit;
  const rank = (card % 13) + 2;
  d[seat][suit] &= ~rankBit(rank);
}

export function addCard(d: Deal, seat: Seat, card: number): void {
  const suit = Math.floor(card / 13) as Suit;
  const rank = (card % 13) + 2;
  d[seat][suit] |= rankBit(rank);
}

/**
 * 解析 PBN 风格的牌串，例如：
 *   "N:QJT9.KQJT9.543.2 AK876.54.AQJ.76 5432.A87.KT6.A8 ..."
 * 顺序固定 N E S W，花色顺序 S H D C（PBN 约定，高花在前）。
 * 单个花色写法：AKQJT98765432 的子串，"-" 表示空门。
 * 也接受显式首引座位前缀（N:/E:/S:/W:），随后按顺时针轮转。
 */
export function parsePBNDeal(text: string): Deal {
  const s = text.trim().replace(/\s+/g, ' ');
  let firstSeat: Seat = 0;
  let body = s;
  const prefix = s.match(/^([NESW]):/);
  if (prefix) {
    firstSeat = (['N', 'E', 'S', 'W'] as string[]).indexOf(prefix[1]!) as Seat;
    body = s.slice(prefix[0].length);
  }
  const parts = body.split(' ').filter((p) => p.length > 0);
  if (parts.length !== 4) throw new Error(`牌串必须包含四家牌，实际 ${parts.length} 家`);

  const deal: Deal = [emptyHand(), emptyHand(), emptyHand(), emptyHand()];
  let seat = firstSeat;
  for (const part of parts) {
    const suitTexts = part.split('.');
    if (suitTexts.length !== 4) {
      throw new Error(`每家牌必须是四个花色（S.H.D.C），收到：${part}`);
    }
    // PBN 花色顺序 S H D C -> 内部顺序 C D H S（suit 0..3）
    const suitOrder: Suit[] = [3, 2, 1, 0];
    for (let i = 0; i < 4; i++) {
      const suit = suitOrder[i]!;
      let mask = 0;
      for (const ch of suitTexts[i]!) {
        if (ch === '-') continue;
        const rank = parseRankChar(ch);
        mask |= rankBit(rank);
      }
      deal[seat][suit] = mask;
    }
    seat = nextSeat(seat);
  }
  validateDeal(deal);
  return deal;
}

function parseRankChar(ch: string): number {
  switch (ch) {
    case 'T': return 10;
    case 'J': return 11;
    case 'Q': return 12;
    case 'K': return 13;
    case 'A': return 14;
    default: {
      const r = Number(ch);
      if (r < 2 || r > 9) throw new Error(`无法识别的牌点：${ch}`);
      return r;
    }
  }
}

/** 输出 PBN 风格牌串（N: 开头，S.H.D.C 顺序），用于回显与导出 */
export function toPBNDeal(d: Deal): string {
  const suitOrder: Suit[] = [3, 2, 1, 0];
  const parts = SEATS.map((seat) =>
    suitOrder
      .map((suit) => maskToPBN(d[seat][suit]))
      .join('.'),
  );
  return `N:${parts.join(' ')}`;
}

function maskToPBN(mask: number): string {
  if (mask === 0) return '-';
  let out = '';
  for (let rank = 14; rank >= 2; rank--) {
    if (mask & rankBit(rank)) {
      out += rank === 10 ? 'T' : rank < 10 ? String(rank) : 'JQKA'[rank - 11]!;
    }
  }
  return out;
}

/** 校验：52 张牌各出现一次、每家 13 张 */
export function validateDeal(d: Deal): void {
  const seen = new Array<number>(52).fill(0);
  for (const seat of SEATS) {
    let count = 0;
    for (const suit of SUITS) {
      const mask = d[seat][suit];
      if (mask & 0xe000) throw new Error(`花色掩码超出 13 位：${mask}`);
      count += bitCount(mask);
      for (let rank = 2; rank <= 14; rank++) {
        if (mask & rankBit(rank)) seen[cardId(suit, rank)]!++;
      }
    }
    if (count !== 13) {
      throw new Error(`${SEAT_NAMES[seat]} 家持牌 ${count} 张，应为 13 张`);
    }
  }
  const missing = seen.map((n, i) => (n !== 1 ? i : -1)).filter((i) => i >= 0);
  if (missing.length) {
    throw new Error(`以下牌缺失或重复：${missing.join(',')}`);
  }
}

/**
 * 四家座位整体顺时针旋转 k 位（N->E->S->W），牌随之转到新座位。
 * 用于不变量测试：rotate(deal) 后，同一将牌下各座位的结果也应同步旋转。
 */
export function rotateDeal(d: Deal, k: number): Deal {
  const out: Deal = [emptyHand(), emptyHand(), emptyHand(), emptyHand()];
  for (const seat of SEATS) {
    out[(seat + k) & 3] = [...d[seat]] as Hand;
  }
  return out;
}

/**
 * 交换两个花色（无将结果不变，有将结果按花色映射）。
 * 用于不变量测试：换花色只是重命名，各座位拿墩数不变。
 */
export function swapSuits(d: Deal, a: Suit, b: Suit): Deal {
  const out = cloneDeal(d);
  for (const h of out) {
    const t = h[a];
    h[a] = h[b];
    h[b] = t;
  }
  return out;
}
