/**
 * Seeded deterministic RNG.
 *
 * `Math.random` is banned in this project. A corpus that cannot be regenerated
 * byte-for-byte from a seed cannot be audited, and a fuzz failure that cannot
 * be reproduced is a rumour.
 *
 * mulberry32: small, fast, good enough for corpus sampling. Not cryptographic
 * and never used for anything that needs to be.
 */
export class Rng {
  #state: number;
  readonly seed: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new TypeError(`Rng seed must be an integer, got ${String(seed)}`);
    }
    this.seed = seed;
    this.#state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    if (min > max) throw new RangeError(`int(${min}, ${max}): min exceeds max`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform choice. Throws on an empty list rather than returning undefined. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() from an empty array');
    return items[this.int(0, items.length - 1)]!;
  }

  /** Uniform choice excluding `exclude`. Returns null if nothing else remains. */
  pickOther<T>(items: readonly T[], exclude: (item: T) => boolean): T | null {
    const pool = items.filter((i) => !exclude(i));
    return pool.length === 0 ? null : this.pick(pool);
  }

  /** Fisher-Yates on a copy. Never mutates the input. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = out[i]!;
      const b = out[j]!;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  /** A fresh independent stream, derived deterministically. */
  fork(label: string): Rng {
    let h = this.seed >>> 0;
    for (let i = 0; i < label.length; i++) {
      h = (Math.imul(h ^ label.charCodeAt(i), 0x01000193) + 1) >>> 0;
    }
    return new Rng(h);
  }
}
