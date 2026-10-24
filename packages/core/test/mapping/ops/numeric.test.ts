import { describe, expect, it } from 'vite-plus/test'
import { convertUnit } from '../../../src/mapping/ops/numeric'
import { t } from '../../../src/mapping/types'
import { compile, compileError, env, evaluate, evaluateError, typeOf } from '../helpers'

const fields = {
  n: t.nullable(t.number),
  s: t.string,
  w: t.nullable(t.number),
  unit: t.nullable(t.string),
  v: t.number,
}
const from = (path: string) => ({ op: 'extract', path })
const calc = (step: object, n: number | null) => evaluate([from('n'), step], { n }, { fields })

describe.each([
  ['add', 'value', 2, 5, 7],
  ['subtract', 'value', 2, 5, 3],
  ['multiply', 'by', 2, 5, 10],
  ['divide', 'by', 2, 5, 2.5],
])('%s', (op, key, operand, input, expected) => {
  it(`${input} with ${operand} -> ${expected}`, () => {
    expect(calc({ op, [key]: operand }, input)).toBe(expected)
  })

  it('propagates null and is typed number, infallible', () => {
    expect(calc({ op, [key]: operand }, null)).toBeNull()
    expect(typeOf([from('n'), { op, [key]: operand }], { fields })).toBe('number?')
    expect(compile([from('n'), { op, [key]: operand }], { fields }).fallible).toBe(false)
  })

  it.each([
    [{ [key]: Infinity }, 'received Infinity'],
    [{ [key]: 'x' }, key],
    [{}, key],
  ])('rejects params %j', (params, message) => {
    expect(compileError([from('n'), { op, ...params }], { fields })).toContain(message)
  })

  it('rejects strings', () => {
    expect(compileError([from('s'), { op, [key]: 1 }], { fields })).toContain(
      `${op} expects number, got string`,
    )
  })
})

describe('divide', () => {
  it('rejects division by zero at save', () => {
    expect(compileError([from('n'), { op: 'divide', by: 0 }], { fields })).toContain(
      'divide by zero',
    )
  })
})

describe('round', () => {
  it.each([
    [2.5, {}, 3],
    [-2.5, {}, -3],
    [-0.4, {}, 0],
    [-0.4, { mode: 'ceil' }, 0],
    [1.005, { precision: 2 }, 1.01],
    [1.2345, { precision: 3, mode: 'floor' }, 1.234],
    [-1.2345, { precision: 3, mode: 'floor' }, -1.235],
    [1.2341, { precision: 3, mode: 'ceil' }, 1.235],
    [2.5, { mode: 'half_even' }, 2],
    [3.5, { mode: 'half_even' }, 4],
    [-2.5, { mode: 'half_even' }, -2],
    [2.6, { mode: 'half_even' }, 3],
    [2.4, { mode: 'half_even' }, 2],
    [1.5e-7, { precision: 7 }, 2e-7],
  ])('%d with %j -> %d', (value, params, expected) => {
    const result = calc({ op: 'round', ...params }, value)
    expect(result).toBe(expected)
    expect(Object.is(result, -0)).toBe(false)
  })

  it.each([
    [{ precision: 16 }, 'precision'],
    [{ precision: 1.5 }, 'precision'],
    [{ mode: 'up' }, 'mode'],
  ])('rejects %j', (params, message) => {
    expect(compileError([from('n'), { op: 'round', ...params }], { fields })).toContain(message)
  })

  it('is typed number', () => {
    expect(typeOf([from('v'), { op: 'round' }], { fields })).toBe('number')
    expect(compileError([from('s'), { op: 'round' }], { fields })).toContain('round expects number')
  })
})

describe('abs', () => {
  it('drops the sign', () => {
    expect(calc({ op: 'abs' }, -3)).toBe(3)
    expect(calc({ op: 'abs' }, null)).toBeNull()
    expect(compileError([from('s'), { op: 'abs' }], { fields })).toContain('abs expects number')
    expect(compileError([from('n'), { op: 'abs', by: 1 }], { fields })).toContain('by')
  })
})

describe('clamp', () => {
  it.each([
    [{ min: 0 }, -5, 0],
    [{ min: 0 }, 5, 5],
    [{ max: 10 }, 50, 10],
    [{ min: 0, max: 10 }, 5, 5],
    [{ min: 3, max: 3 }, 5, 3],
  ])('%j clamps %d to %d', (params, value, expected) => {
    expect(calc({ op: 'clamp', ...params }, value)).toBe(expected)
  })

  it.each([
    [{}, 'clamp needs min or max'],
    [{ min: 5, max: 1 }, 'min is above max'],
    [{ min: 'a' }, 'min'],
  ])('rejects %j', (params, message) => {
    expect(compileError([from('n'), { op: 'clamp', ...params }], { fields })).toContain(message)
  })

  it('rejects strings', () => {
    expect(compileError([from('s'), { op: 'clamp', min: 0 }], { fields })).toContain(
      'clamp expects number',
    )
  })
})

describe('convert_unit', () => {
  const pair = [
    { op: 'extract', path: ['w', 'unit'] },
    { op: 'convert_unit', to: 'g' },
  ]

  it('converts a (value, unit) tuple read from the record', () => {
    expect(typeOf(pair, { fields })).toBe('number?')
    expect(evaluate(pair, { w: 2, unit: 'kg' }, { fields })).toBe(2000)
    expect(evaluate(pair, { w: 2, unit: 'KG' }, { fields })).toBe(2000)
    expect(evaluate(pair, { w: 1, unit: 'lb' }, { fields })).toBe(453.59237)
    expect(compile(pair, { fields }).fallible).toBe(true)
  })

  it('is non-null when the value is', () => {
    expect(
      typeOf(
        [
          { op: 'extract', path: ['v', 's'] },
          { op: 'convert_unit', to: 'g' },
        ],
        { fields },
      ),
    ).toBe('number')
  })

  it('yields null for a null value, and raises for a missing or unknown unit', () => {
    expect(evaluate(pair, { w: null, unit: 'kg' }, { fields })).toBeNull()
    expect(evaluateError(pair, { w: 2, unit: null }, { fields })).toMatchObject({
      code: 'unknown_unit',
      detail: 'no unit given for 2',
    })
    expect(evaluateError(pair, { w: 2, unit: 'stone' }, { fields })).toMatchObject({
      code: 'unknown_unit',
      detail: 'cannot convert stone to g',
    })
    expect(evaluateError(pair, { w: 2, unit: 'm' }, { fields }).detail).toBe(
      'cannot convert m to g',
    )
  })

  it('converts a number with a static from, infallibly', () => {
    const steps = [from('n'), { op: 'convert_unit', from: 'mm', to: 'm' }]
    expect(evaluate(steps, { n: 1500 }, { fields })).toBe(1.5)
    expect(typeOf(steps, { fields })).toBe('number?')
    expect(compile(steps, { fields }).fallible).toBe(false)
    expect(convertUnit.fallible({ to: 'g' }, env(), t.number)).toBe(true)
  })

  it.each([
    [[from('n'), { op: 'convert_unit', to: 'g' }], 'needs a unit input or a "from" param'],
    [[from('s'), { op: 'convert_unit', from: 'g', to: 'kg' }], 'convert_unit expects number'],
    [
      [
        { op: 'extract', path: ['w', 'unit'] },
        { op: 'convert_unit', from: 'kg', to: 'g' },
      ],
      'not both',
    ],
    [
      [
        { op: 'extract', path: ['s', 'unit'] },
        { op: 'convert_unit', to: 'g' },
      ],
      'expects (number, string)',
    ],
    [
      [
        { op: 'extract', path: ['w', 'w'] },
        { op: 'convert_unit', to: 'g' },
      ],
      'expects (number, string)',
    ],
    [
      [
        { op: 'extract', path: ['w'] },
        { op: 'convert_unit', to: 'g' },
      ],
      'expects (number, string)',
    ],
    [[from('n'), { op: 'convert_unit', from: 'kg', to: 'm' }], 'measure different things'],
    [[from('n'), { op: 'convert_unit', from: 'stone', to: 'g' }], 'unknown unit'],
    [[from('n'), { op: 'convert_unit', from: 'g', to: 'stone' }], 'unknown unit'],
    [[from('n'), { op: 'convert_unit' }], 'to'],
  ])('rejects %j', (steps, message) => {
    expect(compileError(steps, { fields })).toContain(message)
  })
})
