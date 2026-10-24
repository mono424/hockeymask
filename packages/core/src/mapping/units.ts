/**
 * The unit table behind `convert_unit`: mass, length and volume, each against one base unit.
 * Unit names are matched case-insensitively. Anything else, and any conversion across
 * dimensions, is unknown.
 */

type Dimension = 'mass' | 'length' | 'volume'

const UNITS: Readonly<Record<string, { readonly dimension: Dimension; readonly factor: number }>> =
  {
    // mass, in grams
    mg: { dimension: 'mass', factor: 0.001 },
    g: { dimension: 'mass', factor: 1 },
    kg: { dimension: 'mass', factor: 1000 },
    t: { dimension: 'mass', factor: 1_000_000 },
    oz: { dimension: 'mass', factor: 28.349523125 },
    lb: { dimension: 'mass', factor: 453.59237 },
    // length, in metres
    mm: { dimension: 'length', factor: 0.001 },
    cm: { dimension: 'length', factor: 0.01 },
    m: { dimension: 'length', factor: 1 },
    km: { dimension: 'length', factor: 1000 },
    in: { dimension: 'length', factor: 0.0254 },
    ft: { dimension: 'length', factor: 0.3048 },
    // volume, in litres
    ml: { dimension: 'volume', factor: 0.001 },
    l: { dimension: 'volume', factor: 1 },
    m3: { dimension: 'volume', factor: 1000 },
  }

const unit = (name: string) => UNITS[name.trim().toLowerCase()]

export function isUnit(name: string): boolean {
  return unit(name) !== undefined
}

/** Multiply by this to convert `from` into `to`; undefined if unknown or across dimensions. */
export function conversionFactor(from: string, to: string): number | undefined {
  const a = unit(from)
  const b = unit(to)
  if (!a || !b || a.dimension !== b.dimension) return undefined
  // Divide instead of multiplying by a reciprocal, so kg -> g is exactly 1000.
  return a.factor / b.factor
}
