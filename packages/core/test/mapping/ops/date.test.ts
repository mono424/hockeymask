import { describe, expect, it } from 'vite-plus/test'
import { Instant } from '../../../src/mapping/time'
import { t } from '../../../src/mapping/types'
import { compile, compileError, evaluate, typeOf } from '../helpers'

const fields = { d: t.nullable(t.date), s: t.string }
const at = (iso: string) => Instant.parse(iso) as Instant
const on = (step: object, iso: string | null, tz = 'UTC') =>
  evaluate(
    [{ op: 'extract', path: 'd' }, step],
    { d: iso === null ? null : at(iso) },
    { fields, ctx: { tz } },
  )
const iso = (step: object, value: string, tz?: string) =>
  (on(step, value, tz) as Instant).toISOString()

describe('format_date', () => {
  it('formats in the run time zone, or in tz', () => {
    const step = { op: 'format_date', format: 'YYYY-MM-DD HH:mm:ss' }
    expect(on(step, '2026-10-04T22:30:05Z')).toBe('2026-10-04 22:30:05')
    expect(on(step, '2026-10-04T22:30:05Z', 'Europe/Berlin')).toBe('2026-10-05 00:30:05')
    expect(on({ ...step, tz: 'Asia/Tokyo' }, '2026-10-04T22:30:05Z', 'Europe/Berlin')).toBe(
      '2026-10-05 07:30:05',
    )
    expect(on({ op: 'format_date', format: 'iso' }, '2026-10-04T22:30:05Z')).toBe(
      '2026-10-04T22:30:05.000Z',
    )
    expect(on({ op: 'format_date', format: 'epoch_s' }, '1970-01-02T00:00:00Z')).toBe('86400')
  })

  it('is typed string, infallible, and propagates null', () => {
    const steps = [
      { op: 'extract', path: 'd' },
      { op: 'format_date', format: 'YYYY' },
    ]
    expect(typeOf(steps, { fields })).toBe('string?')
    expect(compile(steps, { fields }).fallible).toBe(false)
    expect(on({ op: 'format_date', format: 'YYYY' }, null)).toBeNull()
  })

  it.each([
    [{ format: 'nope' }, 'has none of'],
    [{ format: 'YYYY', tz: 'Nowhere/City' }, 'unknown time zone'],
    [{}, 'format'],
  ])('rejects %j', (params, message) => {
    expect(
      compileError(
        [
          { op: 'extract', path: 'd' },
          { op: 'format_date', ...params },
        ],
        { fields },
      ),
    ).toContain(message)
  })

  it('rejects non-dates', () => {
    expect(
      compileError(
        [
          { op: 'extract', path: 's' },
          { op: 'format_date', format: 'YYYY' },
        ],
        { fields },
      ),
    ).toContain('format_date expects date, got string')
  })
})

describe('shift_date', () => {
  it.each([
    ['+10y', '2026-10-04T12:00:00Z', '2036-10-04T12:00:00.000Z'],
    ['-30d', '2026-10-04T12:00:00Z', '2026-09-04T12:00:00.000Z'],
    ['+1mo', '2026-01-31T00:00:00Z', '2026-02-28T00:00:00.000Z'],
    ['+1y', '2028-02-29T00:00:00Z', '2029-02-28T00:00:00.000Z'],
    ['+2w', '2026-10-04T12:00:00Z', '2026-10-18T12:00:00.000Z'],
    ['+36h', '2026-10-04T12:00:00Z', '2026-10-06T00:00:00.000Z'],
    ['+1y-1d', '2026-10-04T12:00:00Z', '2027-10-03T12:00:00.000Z'],
  ])('%s from %s', (by, from, expected) => {
    expect(iso({ op: 'shift_date', by }, from)).toBe(expected)
  })

  it('keeps the wall-clock time across a DST change in the run time zone', () => {
    // Berlin leaves summer time on 2026-10-25: noon stays noon, the UTC hour moves.
    expect(iso({ op: 'shift_date', by: '+1d' }, '2026-10-24T10:00:00Z', 'Europe/Berlin')).toBe(
      '2026-10-25T11:00:00.000Z',
    )
  })

  it('is typed date and rejects bad durations', () => {
    expect(
      typeOf(
        [
          { op: 'extract', path: 'd' },
          { op: 'shift_date', by: '+1d' },
        ],
        { fields },
      ),
    ).toBe('date?')
    expect(
      compileError(
        [
          { op: 'extract', path: 'd' },
          { op: 'shift_date', by: '10y' },
        ],
        { fields },
      ),
    ).toContain('invalid duration')
    expect(
      compileError(
        [
          { op: 'extract', path: 's' },
          { op: 'shift_date', by: '+1d' },
        ],
        { fields },
      ),
    ).toContain('shift_date expects date')
  })
})

describe('truncate_date', () => {
  it.each([
    ['day', '2026-10-04T12:34:56Z', '2026-10-04T00:00:00.000Z'],
    ['month', '2026-10-04T12:34:56Z', '2026-10-01T00:00:00.000Z'],
    ['year', '2026-10-04T12:34:56Z', '2026-01-01T00:00:00.000Z'],
  ])('%s of %s', (unit, from, expected) => {
    expect(iso({ op: 'truncate_date', unit }, from)).toBe(expected)
  })

  it('truncates in the run time zone', () => {
    expect(iso({ op: 'truncate_date', unit: 'day' }, '2026-10-04T23:30:00Z', 'Europe/Berlin')).toBe(
      '2026-10-04T22:00:00.000Z',
    )
  })

  it('rejects unknown units and non-dates', () => {
    expect(
      compileError(
        [
          { op: 'extract', path: 'd' },
          { op: 'truncate_date', unit: 'week' },
        ],
        { fields },
      ),
    ).toContain('unit')
    expect(
      compileError(
        [
          { op: 'extract', path: 's' },
          { op: 'truncate_date', unit: 'day' },
        ],
        { fields },
      ),
    ).toContain('truncate_date expects date')
  })
})

describe('to_utc', () => {
  it('is the identity on instants', () => {
    expect(iso({ op: 'to_utc' }, '2026-10-04T12:00:00+02:00')).toBe('2026-10-04T10:00:00.000Z')
    expect(typeOf([{ op: 'extract', path: 'd' }, { op: 'to_utc' }], { fields })).toBe('date?')
    expect(compileError([{ op: 'extract', path: 's' }, { op: 'to_utc' }], { fields })).toContain(
      'to_utc expects date',
    )
    expect(
      compileError(
        [
          { op: 'extract', path: 'd' },
          { op: 'to_utc', tz: 'UTC' },
        ],
        { fields },
      ),
    ).toContain('tz')
  })
})
