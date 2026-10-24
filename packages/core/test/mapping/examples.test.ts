import { describe, expect, it } from 'vite-plus/test'
import type { MappingVersionInput } from '../../src/mapping/document'
import { runExamples } from '../../src/mapping/examples'
import { planOf, schemaOf, targetsOf, versionOf } from './helpers'

const targets = targetsOf({ t: { a: 'string', d: 'date?' } })
const env = { targets }

const rows = [{ a: 'x', iso: '2026-10-04T23:30:00Z' }]

type Example = NonNullable<MappingVersionInput['examples']>[number]

/** s -> m (a, d) -> out; `clock` adds a field compared with today. */
function v(
  examples: Example[],
  options: { clock?: boolean; expect?: MappingVersionInput['expect'] } = {},
) {
  return versionOf({
    expectedSchema: { s: schemaOf({ a: 'string', iso: 'string' }) },
    nodes: [
      { id: 's', op: 'source', system: 'x', entity: 'y' },
      {
        id: 'm',
        op: 'map',
        in: 's',
        fields: [
          { key: 'a', pipeline: [{ op: 'extract', path: 'a' }] },
          {
            key: 'd',
            pipeline: [
              { op: 'extract', path: 'iso' },
              { op: 'to_date', format: 'iso' },
              ...(options.clock ? [{ op: 'if_after', date: 'today', then: null }] : []),
            ],
          },
        ],
      },
      { id: 'out', op: 'sink', in: 'm', target: 't', key: ['a'] },
    ],
    examples,
    ...(options.expect ? { expect: options.expect } : {}),
  })
}

const results = (examples: Example[], options = {}) =>
  runExamples(planOf(v(examples, options), env))
const only = (examples: Example[], options = {}) => results(examples, options)[0]

describe('runExamples', () => {
  it('passes when every listed relation matches as a set on its fields', () => {
    const result = only([
      {
        name: 'one row',
        sources: { s: rows },
        expect: {
          m: [{ a: 'x', d: '2026-10-04T23:30:00.000Z' }],
          out: [{ a: 'x', d: '2026-10-04' }],
        },
      },
    ])
    expect(result).toMatchObject({
      index: 0,
      name: 'one row',
      passed: true,
      failures: [],
      diffs: [],
      issues: [],
    })
    expect(result?.run?.status).toBe('ok')
  })

  it('compares sink rows as written, in the example time zone', () => {
    const result = only([
      { sources: { s: rows }, tz: 'Asia/Tokyo', expect: { out: [{ a: 'x', d: '2026-10-05' }] } },
    ])
    expect(result).toMatchObject({ passed: true })
    expect(result).not.toHaveProperty('name')
  })

  it('reports missing and unexpected records', () => {
    const result = only([{ sources: { s: rows }, expect: { m: [{ a: 'y' }] } }])
    expect(result).toMatchObject({
      passed: false,
      failures: [],
      diffs: [{ node: 'm', missing: [{ a: 'y' }], unexpected: [{ a: 'x' }] }],
    })
  })

  it('treats an empty expected relation as "no records"', () => {
    expect(only([{ sources: {}, expect: { m: [] } }])).toMatchObject({ passed: true, diffs: [] })
    expect(only([{ sources: { s: rows }, expect: { m: [] } }])?.diffs).toEqual([
      { node: 'm', missing: [], unexpected: [{ a: 'x', d: '2026-10-04T23:30:00.000Z' }] },
    ])
  })

  it('reads a field the output does not have as null', () => {
    expect(only([{ sources: { s: rows }, expect: { m: [{ a: 'x', zz: null }] } }])).toMatchObject({
      passed: true,
    })
  })

  it('needs every expected record of a node to list the same fields', () => {
    expect(
      only([{ sources: { s: rows }, expect: { m: [{ a: 'x' }, { d: null }] } }])?.failures,
    ).toEqual(['expected rows of m must all list the same fields'])
  })

  it.each([
    [{ sources: { m: [] }, expect: {} }, {}, "sources names 'm', which is not a source node"],
    [{ sources: {}, expect: { ghost: [] } }, {}, "expect names unknown node 'ghost'"],
    [
      { sources: {} },
      { clock: true },
      'the graph reads the clock (today/now), so the example needs "now"',
    ],
    [{ sources: {}, now: 'tomorrow' }, {}, "now 'tomorrow' is not an ISO instant"],
    [{ sources: {}, tz: 'Mars/Olympus' }, {}, "unknown time zone 'Mars/Olympus'"],
  ])('rejects an example it cannot run: %#', (example, options, failure) => {
    expect(only([example as Example], options)).toEqual({
      index: 0,
      passed: false,
      failures: [failure],
      diffs: [],
      issues: [],
    })
  })

  it('accepts a pinned clock for a graph that reads it', () => {
    expect(
      only([{ sources: { s: rows }, now: '2026-01-01T00:00:00Z' }], { clock: true }),
    ).toMatchObject({
      passed: true,
    })
  })

  it('fails when the run stops, naming what stopped it', () => {
    const result = only([{ sources: { s: [...rows, ...rows] } }], {
      expect: { m: { unique: ['a'], onFail: 'stop' } },
    })
    // Fixtures keep running after a stop, so the sink's own failure shows up too.
    expect(result?.failures).toEqual([
      'run stopped: m: a not unique: 1 duplicated keys',
      'out failed: a ["x"] is written twice',
    ])
  })

  it('fails when a node fails, and on outputs that never appeared', () => {
    const result = only([{ sources: { s: [{ a: 1, iso: 'x' }] }, expect: { m: [{ a: 'x' }] } }])
    expect(result?.failures).toEqual([
      's failed: 1 fields do not match the declared schema; a: 1 values are not string',
      'm produced no output',
    ])
  })

  it('names a stop without a stop action plainly', () => {
    const plan = planOf(
      versionOf({
        expectedSchema: { s: schemaOf({ a: 'string' }) },
        nodes: [
          { id: 's', op: 'source', system: 'x', entity: 'y' },
          {
            id: 'm',
            op: 'map',
            in: 's',
            on_error: 'fail_sync',
            fields: [
              { key: 'a', pipeline: [{ op: 'extract', path: 'a' }] },
              {
                key: 'd',
                pipeline: [
                  { op: 'extract', path: 'a' },
                  { op: 'to_date', format: 'iso' },
                ],
              },
            ],
          },
          { id: 'out', op: 'sink', in: 'm', target: 't', key: ['a'] },
        ],
        examples: [{ sources: { s: [{ a: 'x' }] } }],
      }),
      env,
    )
    expect(runExamples(plan)[0]?.failures).toEqual([
      'run stopped',
      "m failed: d step 1 to_date: 'x' does not match date format iso",
    ])
  })
})
