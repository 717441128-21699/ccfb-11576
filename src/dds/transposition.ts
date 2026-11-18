/**
 * 双明手置换表（Transposition Table）。
 *
 * 键 = 64 位 Zobrist（两张 Uint32 分高低字）异或局面上下文
 * （将牌、出牌人、当前赢张花色/牌点、赢家座位、当前墩序号）。
 * 注意：键里【不含】已赢墩数——搜索值定义为“剩余牌还能赢几墩”，
 * 与历史出牌路径无关，这样不同出牌顺序到达的同一残局能共享表项。
 *
 * 值打包在一个 Int32 里：
 *   bits 0..4  : nsTricks + 7（剩余拿墩数 0..13 平移为正数）
 *   bits 5..6  : bound 类型（0 精确 / 1 下界 / 2 上界）
 *   bits 7..10 : 当前墩序号（0..12，4 位）
 *   bits 11..16: 最佳走法的牌编号 0..51，63 表示无
 */

export const BOUND_EXACT = 0;
export const BOUND_LOWER = 1;
export const BOUND_UPPER = 2;

const VALUE_OFFSET = 7;
const NO_MOVE = 63;

export class TranspositionTable {
  readonly mask: number;
  private readonly key1: Uint32Array;
  private readonly key2: Uint32Array;
  private readonly val: Int32Array;
  private probes = 0;
  private hits = 0;

  constructor(logSize = 20) {
    const size = 1 << logSize;
    this.mask = size - 1;
    this.key1 = new Uint32Array(size);
    this.key2 = new Uint32Array(size);
    this.val = new Int32Array(size);
  }

  static packValue(
    nsTricks: number,
    bound: number,
    trickIndex: number,
    bestCard: number,
  ): number {
    return (
      (nsTricks + VALUE_OFFSET) |
      (bound << 5) |
      (trickIndex << 7) |
      (bestCard << 11)
    );
  }

  static unpackTricks(v: number): number {
    return (v & 0x1f) - VALUE_OFFSET;
  }
  static unpackBound(v: number): number {
    return (v >>> 5) & 0x3;
  }
  static unpackTrickIndex(v: number): number {
    return (v >>> 7) & 0xf;
  }
  static unpackBestCard(v: number): number {
    return (v >>> 11) & 0x3f;
  }

  clear(): void {
    this.key1.fill(0);
    this.key2.fill(0);
    this.val.fill(0);
    this.probes = 0;
    this.hits = 0;
  }

  stats(): { probes: number; hits: number; hitRate: number } {
    return {
      probes: this.probes,
      hits: this.hits,
      hitRate: this.probes === 0 ? 0 : this.hits / this.probes,
    };
  }

  store(effectiveKey1: number, effectiveKey2: number, packed: number): void {
    const idx = (effectiveKey1 ^ effectiveKey2) & this.mask;
    this.key1[idx] = effectiveKey1;
    this.key2[idx] = effectiveKey2;
    this.val[idx] = packed;
  }

  probe(effectiveKey1: number, effectiveKey2: number): number | null {
    this.probes++;
    const idx = (effectiveKey1 ^ effectiveKey2) & this.mask;
    if (this.key1[idx] === effectiveKey1 && this.key2[idx] === effectiveKey2) {
      this.hits++;
      return this.val[idx]!;
    }
    return null;
  }

  static get noMove(): number {
    return NO_MOVE;
  }
}
