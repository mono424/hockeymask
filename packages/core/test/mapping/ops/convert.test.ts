import { describe, expect, it } from 'vite-plus/test'
import { Instant } from '../../../src/mapping/time'
import { t } from '../../../src/mapping/types'
import { compile, compileError, evaluate, evaluateError, typeOf } from '../helpers'

const fields = {
  s: t.nullable(t.string),
  n: t.nullable(t.number),
  b: t.boolean,
  d: t.date,
  l: t.list(t.number),
  u: t.unknown,
}
const from = (path: string) => ({ op: 'extract', path })
const at = (iso: string) => Instant.parse(iso) as Instant

describe('to_number', () => {
  it.each([
    ['12', 12],
    [' -1.5 ', -1.5],
    ['.5', 0.5],
    ['1.', 1],
    ['+1e3', 1000],
    ['n/a', null],
    ['', null],
    [null, null],
  ])('non-strict %j -> %j', (value, expected) => {
    expect(evaluate([from('s'), { op: 'to_number' }], { s: value }, { fields })).toBe(expected)
  })

  it('types non-strict as number? and strict as number', () => {
    expect(typeOf([from('s'), { op: 'to_number' }], { fields })).toBe('number?')
    expect(compile([from('s'), { op: 'to_number' }], { fields }).fallible).toBe(false)
    const strict = [from('s'), { op: 'to_number', strict: true }]
    expect(compile(strict, { fields }).fallible).toBe(true)
    expect(
      typeOf([
        { op: 'const', value: 'x' },
        { op: 'to_number', strict: true },
      ]),
    ).toBe('number')
  })

  it('strict raises parse_failed', () => {
    expect(
      evaluateError([from('s'), { op: 'to_number', strict: true }], { s: 'n/a' }, { fields }),
    ).toMatchObject({ code: 'parse_failed', detail: "'n/a' is not a number" })
  })

  it('converts booleans to 1 and 0', () => {
    expect(typeOf([from('b'), { op: 'to_number' }], { fields })).toBe('number')
    expect(evaluate([from('b'), { op: 'to_number' }], { b: true }, { fields })).toBe(1)
    expect(evaluate([from('b'), { op: 'to_number' }], { b: false }, { fields })).toBe(0)
  })

  it('rejects numbers and bad params', () => {
    expect(compileError([from('n'), { op: 'to_number' }], { fields })).toContain(
      'to_number expects string or boolean, got number',
    )
    expect(compileError([from('s'), { op: 'to_number', strict: 'yes' }], { fields })).toContain(
      'strict',
    )
  })
})

describe('to_string', () => {
  it.each([
    ['n', 12, '12'],
    ['b', true, 'true'],
    ['s', 'x', 'x'],
    ['l', [1, 2], '[1,2]'],
  ])('%s %j -> %j', (path, value, expected) => {
    expect(evaluate([from(path), { op: 'to_string' }], { [path]: value }, { fields })).toBe(
      expected,
    )
  })

  it('formats dates as ISO by default or with a pattern in the run time zone', () => {
    const record = { d: at('2026-10-04T22:30:00Z') }
    expect(typeOf([from('d'), { op: 'to_string' }], { fields })).toBe('string')
    expect(evaluate([from('d'), { op: 'to_string' }], record, { fields })).toBe(
      '2026-10-04T22:30:00.000Z',
    )
    const pattern = [from('d'), { op: 'to_string', format: 'DD.MM.YYYY HH:mm' }]
    expect(evaluate(pattern, record, { fields, ctx: { tz: 'Europe/Berlin' } })).toBe(
      '05.10.2026 00:30',
    )
  })

  it('rejects a format on non-dates, unknown inputs and bad formats', () => {
    expect(compileError([from('n'), { op: 'to_string', format: 'YYYY' }], { fields })).toContain(
      'format applies to dates only',
    )
    expect(compileError([from('u'), { op: 'to_string' }], { fields })).toContain('known input type')
    expect(compileError([from('d'), { op: 'to_string', format: 'nothing' }], { fields })).toContain(
      'has none of',
    )
  })

  it('is infallible and propagates null', () => {
    expect(compile([from('n'), { op: 'to_string' }], { fields }).fallible).toBe(false)
    expect(evaluate([from('n'), { op: 'to_string' }], { n: null }, { fields })).toBeNull()
  })
})

describe('to_bool', () => {
  it.each([
    ['true', true],
    [' 1 ', true],
    ['false', false],
    ['0', false],
  ])('default values: %j -> %j', (value, expected) => {
    expect(evaluate([from('s'), { op: 'to_bool' }], { s: value }, { fields })).toBe(expected)
  })

  it('converts numbers via their string form', () => {
    expect(evaluate([from('n'), { op: 'to_bool' }], { n: 1 }, { fields })).toBe(true)
    expect(evaluate([from('n'), { op: 'to_bool' }], { n: 0 }, { fields })).toBe(false)
    expect(evaluateError([from('n'), { op: 'to_bool' }], { n: 2 }, { fields }).code).toBe(
      'parse_failed',
    )
  })

  it('uses custom values', () => {
    const steps = [from('s'), { op: 'to_bool', true_values: ['T'], false_values: ['F'] }]
    expect(evaluate(steps, { s: 'T' }, { fields })).toBe(true)
    expect(evaluate(steps, { s: 'F' }, { fields })).toBe(false)
    expect(evaluateError(steps, { s: 'true' }, { fields })).toMatchObject({
      code: 'parse_failed',
      detail: "'true' is not a listed boolean value",
    })
  })

  it('is fallible, typed boolean, and propagates null', () => {
    const steps = [from('s'), { op: 'to_bool' }]
    expect(compile(steps, { fields }).fallible).toBe(true)
    expect(typeOf(steps, { fields })).toBe('boolean?')
    expect(evaluate(steps, { s: null }, { fields })).toBeNull()
  })

  it.each([
    [{ true_values: ['0'] }, 'overlap'],
    [{ false_values: ['1'] }, 'overlap'],
    [{ true_values: ['y'], false_values: ['y'] }, 'overlap'],
    [{ true_values: [] }, 'true_values'],
  ])('rejects %j', (params, message) => {
    expect(compileError([from('s'), { op: 'to_bool', ...params }], { fields })).toContain(message)
  })

  it('rejects booleans', () => {
    expect(compileError([from('b'), { op: 'to_bool' }], { fields })).toContain(
      'to_bool expects string or number, got boolean',
    )
  })
})

describe('to_date', () => {
  const iso = (steps: unknown[], record: Record<string, string | number | null>, tz = 'UTC') =>
    (evaluate(steps, record, { fields, ctx: { tz } }) as Instant).toISOString()

  it('parses patterns in the run time zone, or in tz', () => {
    const steps = [from('s'), { op: 'to_date', format: 'DD.MM.YYYY' }]
    expect(typeOf(steps, { fields })).toBe('date?')
    expect(iso(steps, { s: '04.10.2026' })).toBe('2026-10-04T00:00:00.000Z')
    expect(iso(steps, { s: '04.10.2026' }, 'Europe/Berlin')).toBe('2026-10-03T22:00:00.000Z')
    const fixed = [from('s'), { op: 'to_date', format: 'YYYY-MM-DD', tz: 'America/New_York' }]
    expect(iso(fixed, { s: '2026-01-15' }, 'Europe/Berlin')).toBe('2026-01-15T05:00:00.000Z')
  })

  it('parses iso and epoch formats', () => {
    expect(
      iso([from('s'), { op: 'to_date', format: 'iso' }], { s: '2026-10-04T12:00:00+02:00' }),
    ).toBe('2026-10-04T10:00:00.000Z')
    const ms = [from('n'), { op: 'to_date', format: 'epoch_ms' }]
    expect(iso(ms, { n: 0 })).toBe('1970-01-01T00:00:00.000Z')
    expect(iso([from('s'), { op: 'to_date', format: 'epoch_s' }], { s: '86400' })).toBe(
      '1970-01-02T00:00:00.000Z',
    )
  })

  it('raises parse_failed on a mismatch', () => {
    expect(
      evaluateError(
        [from('s'), { op: 'to_date', format: 'YYYY-MM-DD' }],
        { s: '2026-02-30' },
        { fields },
      ),
    ).toMatchObject({
      code: 'parse_failed',
      detail: "'2026-02-30' does not match date format YYYY-MM-DD",
    })
  })

  it('is fallible and propagates null', () => {
    const steps = [from('s'), { op: 'to_date', format: 'iso' }]
    expect(compile(steps, { fields }).fallible).toBe(true)
    expect(evaluate(steps, { s: null }, { fields })).toBeNull()
  })

  it.each([
    [{ format: 'HH:mm' }, 'needs YYYY, MM and DD'],
    [{ format: 'nothing' }, 'has none of'],
    [{ format: 'iso', tz: 'Mars/Base' }, 'unknown time zone'],
    [{}, 'format'],
  ])('rejects %j', (params, message) => {
    expect(compileError([from('s'), { op: 'to_date', ...params }], { fields })).toContain(message)
  })

  it('takes numbers only with epoch formats', () => {
    expect(compileError([from('n'), { op: 'to_date', format: 'iso' }], { fields })).toContain(
      'to_date expects string, got number',
    )
  })
})

describe('assert_type', () => {
  it('passes a value of the declared type', () => {
    const steps = [from('n'), { op: 'assert_type', type: 'number' }]
    expect(typeOf(steps, { fields })).toBe('number?')
    expect(evaluate(steps, { n: 4 }, { fields })).toBe(4)
    expect(compile(steps, { fields }).fallible).toBe(false)
    expect(typeOf([from('l'), { op: 'assert_type', type: 'list<number?>' }], { fields })).toBe(
      'list<number?>',
    )
  })

  it('rejects a mismatch and an unknown type name', () => {
    expect(compileError([from('s'), { op: 'assert_type', type: 'number' }], { fields })).toContain(
      'expected number, got string',
    )
    expect(compileError([from('s'), { op: 'assert_type', type: 'text' }], { fields })).toContain(
      "unknown type 'text'",
    )
  })
})
