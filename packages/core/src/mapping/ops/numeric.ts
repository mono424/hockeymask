/** Numeric ops: `add`, `subtract`, `multiply`, `divide`, `round`, `abs`, `clamp`, `convert_unit`. */

import { z } from 'zod'
import { err, ok, stepError } from '../result'
import { isNullable, type MType, nullableIf, show, stripNull, t } from '../types'
import { conversionFactor, isUnit } from '../units'
import { defineOp, expectKind, never, params } from './def'

// Zod 4 numbers are finite: Infinity and NaN are rejected.
const finite = z.number()

const numberIn = (op: string) => (input: MType) => {
  const s = expectKind(input, ['number'], op)
  return s.ok ? ok(t.number) : s
}

const arithmetic = <K extends string>(
  name: string,
  key: K,
  apply: (a: number, b: number) => number,
) =>
  defineOp({
    name,
    params: params({ [key]: finite } as { [P in K]: typeof finite }),
    nulls: 'propagate',
    fallible: never,
    signature: numberIn(name),
    run: (p) => {
      const operand = (p as Record<K, number>)[key]
      return (input) => ok(apply(input as number, operand))
    },
  })

export const add = arithmetic('add', 'value', (a, b) => a + b)
export const subtract = arithmetic('subtract', 'value', (a, b) => a - b)
export const multiply = arithmetic('multiply', 'by', (a, b) => a * b)

/** `by: 0` is rejected when the version is saved, never at runtime. */
export const divide = defineOp({
  name: 'divide',
  params: params({ by: finite.refine((n) => n !== 0, 'divide by zero') }),
  nulls: 'propagate',
  fallible: never,
  signature: numberIn('divide'),
  run: (p) => (input) => ok((input as number) / p.by),
})

/** Shift the decimal point by `places` without floating-point drift (1.005 stays 1.005). */
function shiftDecimal(n: number, places: number): number {
  const [mantissa, exponent = '0'] = String(n).split('e')
  return Number(`${mantissa}e${Number(exponent) + places}`)
}

type RoundMode = 'half_up' | 'half_even' | 'floor' | 'ceil'

function roundScaled(x: number, mode: RoundMode): number {
  switch (mode) {
    case 'floor':
      return Math.floor(x)
    case 'ceil':
      return Math.ceil(x)
    case 'half_up':
      return Math.sign(x) * Math.round(Math.abs(x))
    case 'half_even': {
      const a = Math.abs(x)
      const floor = Math.floor(a)
      const diff = a - floor
      const r = diff > 0.5 || (diff === 0.5 && floor % 2 === 1) ? floor + 1 : floor
      return Math.sign(x) * r
    }
  }
}

/** Round to `precision` decimals. `half_up` rounds halves away from zero. */
export const round = defineOp({
  name: 'round',
  params: params({
    precision: z.number().int().min(0).max(15).optional(),
    mode: z.enum(['half_up', 'half_even', 'floor', 'ceil']).optional(),
  }),
  nulls: 'propagate',
  fallible: never,
  signature: numberIn('round'),
  run: (p) => {
    const precision = p.precision ?? 0
    const mode = p.mode ?? 'half_up'
    // The final shift goes through String(), which also turns -0 into 0.
    return (input) =>
      ok(shiftDecimal(roundScaled(shiftDecimal(input as number, precision), mode), -precision))
  },
})

export const abs = defineOp({
  name: 'abs',
  params: params({}),
  nulls: 'propagate',
  fallible: never,
  signature: numberIn('abs'),
  run: () => (input) => ok(Math.abs(input as number)),
})

export const clamp = defineOp({
  name: 'clamp',
  params: params({ min: finite.optional(), max: finite.optional() })
    .refine((p) => p.min !== undefined || p.max !== undefined, 'clamp needs min or max')
    .refine(
      (p) => p.min === undefined || p.max === undefined || p.min <= p.max,
      'min is above max',
    ),
  nulls: 'propagate',
  fallible: never,
  signature: numberIn('clamp'),
  run: (p) => {
    const min = p.min ?? -Infinity
    const max = p.max ?? Infinity
    return (input) => ok(Math.min(max, Math.max(min, input as number)))
  },
})

const unitName = z.string().refine(isUnit, 'unknown unit')

/**
 * Convert over the unit table. The source unit is `from`, or the second element of an
 * extracted `(value, unit)` tuple. With a static `from` the conversion is checked at save
 * and cannot fail; with a unit read from the record an unknown unit raises.
 */
export const convertUnit = defineOp({
  name: 'convert_unit',
  params: params({ to: unitName, from: unitName.optional() }).refine(
    (p) =>
      p.from === undefined ||
      !isUnit(p.from) ||
      !isUnit(p.to) ||
      conversionFactor(p.from, p.to) !== undefined,
    'from and to measure different things',
  ),
  nulls: 'propagate',
  fallible: (p) => p.from === undefined,
  signature: (input, p) => {
    if (input.kind === 'tuple') {
      if (p.from !== undefined)
        return err('convert_unit takes a unit from the record or from "from", not both')
      const [value, unit] = input.of as readonly [MType, MType]
      const pair =
        input.of.length === 2 &&
        stripNull(value).kind === 'number' &&
        stripNull(unit).kind === 'string'
      if (!pair) return err(`convert_unit expects (number, string), got ${show(input)}`)
      return ok(nullableIf(t.number, isNullable(value)))
    }
    if (p.from === undefined) return err('convert_unit needs a unit input or a "from" param')
    return numberIn('convert_unit')(input)
  },
  run: (p, _env, input) => {
    const to = p.to
    if (input.kind !== 'tuple') {
      const factor = conversionFactor(p.from as string, to) as number
      return (v) => ok((v as number) * factor)
    }
    return (v) => {
      const [value, from] = v as readonly [number | null, string | null]
      if (value === null) return ok(null)
      if (from === null) return stepError('unknown_unit', `no unit given for ${value}`)
      const factor = conversionFactor(from, to)
      return factor === undefined
        ? stepError('unknown_unit', `cannot convert ${from} to ${to}`)
        : ok(value * factor)
    }
  },
})
