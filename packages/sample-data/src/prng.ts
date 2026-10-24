/**
 * Seeded, deterministic PRNG with the helpers the generator needs.
 *
 * cyrb128 turns a string seed into 128 bits; sfc32 produces the stream. The same seed
 * string gives the same sequence on every machine and Node version.
 */

function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(seed: string) {
    ;[this.a, this.b, this.c, this.d] = cyrb128(seed)
    for (let i = 0; i < 16; i++) this.random() // let the state mix
  }

  /** Uniform float in [0, 1). */
  random(): number {
    this.a |= 0
    this.b |= 0
    this.c |= 0
    this.d |= 0
    const t = (((this.a + this.b) | 0) + this.d) | 0
    this.d = (this.d + 1) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) | 0
    return (t >>> 0) / 4294967296
  }

  /** Integer in [lo, hi], both inclusive. */
  randint(lo: number, hi: number): number {
    return lo + Math.floor(this.random() * (hi - lo + 1))
  }

  /** Integer in [0, n). */
  randrange(n: number): number {
    return Math.floor(this.random() * n)
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.random()
  }

  /** Same definition as Python's random.triangular. */
  triangular(low: number, high: number, mode: number): number {
    let u = this.random()
    let c = (mode - low) / (high - low)
    let lo = low
    let hi = high
    if (u > c) {
      u = 1 - u
      c = 1 - c
      ;[lo, hi] = [hi, lo]
    }
    return lo + (hi - lo) * Math.sqrt(u * c)
  }

  choice<T>(values: readonly T[]): T {
    return values[this.randrange(values.length)] as T
  }

  /** One value drawn with the given relative weights. */
  choices<T>(values: readonly T[], weights: readonly number[]): T {
    let total = 0
    for (const w of weights) total += w
    let r = this.random() * total
    for (let i = 0; i < values.length; i++) {
      r -= weights[i] as number
      if (r < 0) return values[i] as T
    }
    return values[values.length - 1] as T
  }

  /** k distinct elements, in random order (partial Fisher–Yates on a copy). */
  sample<T>(values: readonly T[], k: number): T[] {
    if (k > values.length) throw new RangeError('sample larger than population')
    const pool = values.slice()
    for (let i = 0; i < k; i++) {
      const j = i + this.randrange(pool.length - i)
      ;[pool[i], pool[j]] = [pool[j] as T, pool[i] as T]
    }
    return pool.slice(0, k)
  }

  shuffle<T>(values: T[]): T[] {
    for (let i = values.length - 1; i > 0; i--) {
      const j = this.randrange(i + 1)
      ;[values[i], values[j]] = [values[j] as T, values[i] as T]
    }
    return values
  }
}
