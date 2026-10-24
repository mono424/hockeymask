import { describe, expect, it } from 'vite-plus/test'
import {
  dateFormat,
  daysInMonth,
  duration,
  formatDate,
  fromWallClock,
  hasFullDate,
  Instant,
  isTimeZone,
  parseDateValue,
  parseDateExpr,
  parseDateFormat,
  parseDuration,
  resolveDateExpr,
  shift,
  toDateString,
  toWallClock,
  truncate,
  usesClock,
  type WallClock,
} from '../../src/mapping/time'

const at = (iso: string) => Instant.parse(iso) as Instant
const wall = (w: Partial<WallClock>): WallClock => ({
  year: 2026,
  month: 1,
  day: 1,
  hour: 0,
  minute: 0,
  second: 0,
  ms: 0,
  ...w,
})
const iso = (i: Instant | undefined) => i?.toISOString()

describe('Instant', () => {
  it('parses strict ISO instants with an offset', () => {
    expect(iso(Instant.parse('2026-10-04T12:00:00+02:00'))).toBe('2026-10-04T10:00:00.000Z')
    expect(iso(Instant.parse('2026-10-04T12:00Z'))).toBe('2026-10-04T12:00:00.000Z')
    expect(Instant.parse('2026-10-04')).toBeUndefined()
    expect(Instant.parse('2026-10-04T12:00:00')).toBeUndefined()
    expect(Instant.parse('2026-13-45T25:61Z')).toBeUndefined()
  })

  it('serialises as ISO and is frozen', () => {
    const i = Instant.ofEpochMs(0)
    expect(i.toJSON()).toBe('1970-01-01T00:00:00.000Z')
    expect(String(i)).toBe('1970-01-01T00:00:00.000Z')
    expect(Object.isFrozen(i)).toBe(true)
    expect(() => Instant.ofEpochMs(Number.NaN)).toThrow(RangeError)
  })
})

describe('time zones', () => {
  it('knows valid zones', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
  })

  it('round-trips wall clocks', () => {
    const w = toWallClock(at('2026-07-01T10:15:30.250Z'), 'Europe/Berlin')
    expect(w).toEqual(wall({ month: 7, day: 1, hour: 12, minute: 15, second: 30, ms: 250 }))
    expect(iso(fromWallClock(w, 'Europe/Berlin'))).toBe('2026-07-01T10:15:30.250Z')
  })

  it('resolves a wall time skipped by DST after the gap', () => {
    // 2026-03-29 02:30 does not exist in Berlin; it resolves to 03:30 CEST.
    expect(
      iso(fromWallClock(wall({ month: 3, day: 29, hour: 2, minute: 30 }), 'Europe/Berlin')),
    ).toBe('2026-03-29T01:30:00.000Z')
  })

  it('resolves an ambiguous wall time to the earlier instant', () => {
    // 2026-10-25 02:30 happens twice in Berlin; the first is still CEST.
    expect(
      iso(fromWallClock(wall({ month: 10, day: 25, hour: 2, minute: 30 }), 'Europe/Berlin')),
    ).toBe('2026-10-25T00:30:00.000Z')
  })

  it('handles years below 100', () => {
    expect(iso(fromWallClock(wall({ year: 50 }), 'UTC'))).toBe('0050-01-01T00:00:00.000Z')
  })

  it.each([
    [2024, 2, 29],
    [2026, 2, 28],
    [1900, 2, 28],
    [2000, 2, 29],
    [2026, 4, 30],
    [2026, 12, 31],
  ])('daysInMonth(%d, %d) = %d', (year, month, days) => {
    expect(daysInMonth(year, month)).toBe(days)
  })
})

describe('durations and calendar math', () => {
  it('parses one or more signed parts', () => {
    expect(parseDuration('+10y')).toEqual({ ok: true, value: [{ amount: 10, unit: 'y' }] })
    expect(parseDuration('+1y-2mo')).toEqual({
      ok: true,
      value: [
        { amount: 1, unit: 'y' },
        { amount: -2, unit: 'mo' },
      ],
    })
    for (const bad of ['', '10y', '+1x', '+1y junk']) expect(parseDuration(bad).ok).toBe(false)
    expect(() => duration('nope')).toThrow('invalid duration')
    expect(duration('-3w')).toEqual([{ amount: -3, unit: 'w' }])
  })

  it.each([
    ['+1y', '2024-02-29T08:00:00Z', '2025-02-28T08:00:00.000Z'],
    ['+4y', '2024-02-29T08:00:00Z', '2028-02-29T08:00:00.000Z'],
    ['-1mo', '2026-03-31T00:00:00Z', '2026-02-28T00:00:00.000Z'],
    ['+13mo', '2026-12-15T00:00:00Z', '2028-01-15T00:00:00.000Z'],
    ['-1d', '2026-01-01T05:00:00Z', '2025-12-31T05:00:00.000Z'],
    ['+1w', '2026-10-04T05:00:00Z', '2026-10-11T05:00:00.000Z'],
    ['-2h', '2026-10-04T01:00:00Z', '2026-10-03T23:00:00.000Z'],
  ])('shift %s from %s', (by, from, expected) => {
    expect(iso(shift(at(from), duration(by), 'UTC'))).toBe(expected)
  })

  it('shifts days by wall clock and hours by elapsed time across DST', () => {
    const before = at('2026-03-28T11:00:00Z') // 12:00 CET
    expect(iso(shift(before, duration('+1d'), 'Europe/Berlin'))).toBe('2026-03-29T10:00:00.000Z')
    expect(iso(shift(before, duration('+24h'), 'Europe/Berlin'))).toBe('2026-03-29T11:00:00.000Z')
  })

  it.each([
    ['day', '2026-10-04T00:00:00.000Z'],
    ['month', '2026-10-01T00:00:00.000Z'],
    ['year', '2026-01-01T00:00:00.000Z'],
  ] as const)('truncate to %s', (unit, expected) => {
    expect(iso(truncate(at('2026-10-04T13:14:15Z'), unit, 'UTC'))).toBe(expected)
  })
})

describe('date expressions', () => {
  const clock = { now: at('2026-10-04T22:30:00Z'), tz: 'UTC' }

  it('resolves today and now against the frozen clock', () => {
    const today = parseDateExpr('today')
    expect(today.ok && usesClock(today.value)).toBe(true)
    expect(today.ok && iso(resolveDateExpr(today.value, clock))).toBe('2026-10-04T00:00:00.000Z')
    const tenYears = parseDateExpr('today+10y')
    expect(tenYears.ok && iso(resolveDateExpr(tenYears.value, clock))).toBe(
      '2036-10-04T00:00:00.000Z',
    )
    const now = parseDateExpr('now-1d')
    expect(now.ok && iso(resolveDateExpr(now.value, clock))).toBe('2026-10-03T22:30:00.000Z')
  })

  it('takes today in the run time zone', () => {
    const today = parseDateExpr('today')
    const berlin = { ...clock, tz: 'Europe/Berlin' } // 00:30 on the 5th in Berlin
    expect(today.ok && iso(resolveDateExpr(today.value, berlin))).toBe('2026-10-04T22:00:00.000Z')
  })

  it('reads literal dates in the run time zone and instants as given', () => {
    const date = parseDateExpr('2030-01-01')
    expect(date.ok && usesClock(date.value)).toBe(false)
    expect(date.ok && iso(resolveDateExpr(date.value, { ...clock, tz: 'Europe/Berlin' }))).toBe(
      '2029-12-31T23:00:00.000Z',
    )
    const instant = parseDateExpr('2030-01-01T00:00:00Z')
    expect(instant.ok && iso(resolveDateExpr(instant.value, clock))).toBe(
      '2030-01-01T00:00:00.000Z',
    )
  })

  it.each(['tomorrow', 'today+10', '2030-02-30', 'now+1q'])('rejects %s', (text) => {
    expect(parseDateExpr(text).ok).toBe(false)
  })
})

describe('formats', () => {
  it('parses format names and patterns', () => {
    expect(dateFormat('iso')).toEqual({ kind: 'iso' })
    expect(dateFormat('epoch_ms')).toEqual({ kind: 'epoch', unit: 'ms' })
    expect(dateFormat('epoch_s')).toEqual({ kind: 'epoch', unit: 's' })
    expect(parseDateFormat('nothing').ok).toBe(false)
    expect(parseDateFormat('YYYY-YYYY').ok).toBe(false)
    expect(() => dateFormat('nothing')).toThrow('has none of')
  })

  it('knows which formats name a full date', () => {
    expect(hasFullDate(dateFormat('DD.MM.YYYY'))).toBe(true)
    expect(hasFullDate(dateFormat('HH:mm'))).toBe(false)
    expect(hasFullDate(dateFormat('iso'))).toBe(true)
  })

  it.each([
    ['DD.MM.YYYY', '04.10.2026', 'UTC', '2026-10-04T00:00:00.000Z'],
    ['YYYY-MM-DD HH:mm:ss', '2026-10-04 13:14:15', 'Europe/Berlin', '2026-10-04T11:14:15.000Z'],
    ['YYYY.MM.DD', '2026.10.04', 'UTC', '2026-10-04T00:00:00.000Z'],
    ['iso', '2026-10-04', 'Europe/Berlin', '2026-10-03T22:00:00.000Z'],
    ['iso', '2026-10-04T13:14:15', 'Europe/Berlin', '2026-10-04T11:14:15.000Z'],
    ['iso', '2026-10-04T13:14:15Z', 'Europe/Berlin', '2026-10-04T13:14:15.000Z'],
  ])('parse %s %s in %s', (format, text, tz, expected) => {
    expect(iso(parseDateValue(text, dateFormat(format), tz))).toBe(expected)
  })

  it.each([
    ['DD.MM.YYYY', '31.02.2026'],
    ['DD.MM.YYYY', '04.13.2026'],
    ['DD.MM.YYYY', '00.10.2026'],
    ['YYYY-MM-DD HH:mm:ss', '2026-10-04 24:00:00'],
    ['YYYY-MM-DD HH:mm:ss', '2026-10-04 23:60:00'],
    ['YYYY-MM-DD HH:mm:ss', '2026-10-04 23:59:60'],
    ['DD.MM.YYYY', '4.10.2026'],
    ['iso', 'yesterday'],
  ])('rejects %s %s', (format, text) => {
    expect(parseDateValue(text, dateFormat(format), 'UTC')).toBeUndefined()
  })

  it('parses epochs from numbers and numeric strings only', () => {
    expect(iso(parseDateValue(1000, dateFormat('epoch_ms'), 'UTC'))).toBe(
      '1970-01-01T00:00:01.000Z',
    )
    expect(iso(parseDateValue('-1', dateFormat('epoch_s'), 'UTC'))).toBe('1969-12-31T23:59:59.000Z')
    expect(parseDateValue('1.5', dateFormat('epoch_s'), 'UTC')).toBeUndefined()
    expect(parseDateValue(Number.POSITIVE_INFINITY, dateFormat('epoch_ms'), 'UTC')).toBeUndefined()
    expect(parseDateValue(20261004, dateFormat('YYYYMMDD'), 'UTC')).toBeUndefined()
  })

  it('formats instants', () => {
    const i = at('2026-10-04T22:30:05Z')
    expect(formatDate(i, dateFormat('iso'), 'Europe/Berlin')).toBe('2026-10-04T22:30:05.000Z')
    expect(formatDate(i, dateFormat('epoch_ms'), 'UTC')).toBe(String(i.epochMs))
    expect(formatDate(at('1970-01-01T00:00:01.999Z'), dateFormat('epoch_s'), 'UTC')).toBe('1')
    expect(formatDate(i, dateFormat('DD/MM/YYYY HH:mm:ss'), 'Europe/Berlin')).toBe(
      '05/10/2026 00:30:05',
    )
    expect(toDateString(i, 'Europe/Berlin')).toBe('2026-10-05')
    expect(toDateString(i, 'UTC')).toBe('2026-10-04')
  })
})
