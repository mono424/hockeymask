import { describe, expect, it } from 'vite-plus/test'
import type { FnDef } from '../../src/mapping/context'
import type { MappingVersionInput } from '../../src/mapping/document'
import { execute, readPlan, readSnapshot } from '../../src/mapping/execute'
import { ok } from '../../src/mapping/result'
import { t } from '../../src/mapping/types'
import { NOW, planOf, runOf, schemaOf, targetsOf, versionOf } from './helpers'

const targets = targetsOf({
  t: { a: 'string', n: 'decimal?', d: 'date?', who: 'string?' },
  u: { a: 'string' },
  w: { k: 'decimal' },
})

const source = (id = 's') => ({ id, op: 'source', system: 'sys', entity: `${id}_entity` })
const extract = (key: string, path = key) => ({ key, pipeline: [{ op: 'extract', path }] })
const count = (id: string, input: string) => ({
  id,
  op: 'aggregate',
  in: input,
  group_by: [],
  fields: { n: { agg: 'count' } },
})

function v(nodes: unknown[], extra: Partial<MappingVersionInput> = {}) {
  return versionOf({
    expectedSchema: {
      s: schemaOf({ a: 'string', n: 'number?' }),
      s2: schemaOf({ k: 'number' }),
    },
    nodes: nodes as MappingVersionInput['nodes'],
    ...extra,
  })
}

const rows = [
  { a: 'x', n: 1 },
  { a: 'y', n: null },
]

/** s -> m -> out, plus a count of s reported as a metric. */
const basic = (extra: Partial<MappingVersionInput> = {}, mapExtra = {}) =>
  v(
    [
      source(),
      { id: 'm', op: 'map', in: 's', fields: [extract('a'), extract('n')], ...mapExtra },
      { id: 'out', op: 'sink', in: 'm', target: 't', key: ['a'] },
      count('g', 's'),
      { id: 'met', op: 'metrics', in: 'g', name: 'rows' },
    ],
    extra,
  )

describe('reading sources', () => {
  it('lists the sources a run needs', () => {
    expect(readPlan(planOf(basic(), { targets }))).toEqual([
      { node: 's', system: 'sys', entity: 's_entity' },
    ])
  })

  it('reads each source once into a frozen snapshot', async () => {
    const reads: string[] = []
    const snapshot = await readSnapshot(planOf(basic(), { targets }), async (source) => {
      reads.push(source.node)
      return rows
    })
    expect(reads).toEqual(['s'])
    expect(snapshot).toEqual({ s: rows })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.s)).toBe(true)
  })
})

describe('the run context', () => {
  const who: FnDef = {
    output: t.string,
    fallible: false,
    run: (_v, ctx) =>
      ok(`${ctx.locale}|${ctx.tz}|${ctx.run.syncRunId}|${ctx.run.mappingVersionId}`),
  }
  const plan = planOf(
    v([
      source(),
      {
        id: 'm',
        op: 'map',
        in: 's',
        fields: [
          extract('a'),
          {
            key: 'who',
            pipeline: [
              { op: 'const', value: 1 },
              { op: 'fn', ref: 'who' },
            ],
          },
          {
            key: 'd',
            pipeline: [
              { op: 'const', value: '2026-10-04T23:30:00Z' },
              { op: 'to_date', format: 'iso' },
            ],
          },
        ],
      },
      { id: 'out', op: 'sink', in: 'm', target: 't', key: ['a'] },
    ]),
    { targets, functions: { who } },
  )
  const written = (run: ReturnType<typeof execute>) => run.sinks[0]?.write?.rows[0]

  it('defaults the time zone, locale and run id', () => {
    expect(
      written(execute(plan, { s: [rows[0] as never] }, { now: '2026-10-04T12:00:00Z' })),
    ).toEqual({
      a: 'x',
      who: 'en|UTC||test@1',
      d: '2026-10-04',
    })
  })

  it('takes them from the run, with `now` as an Instant', () => {
    const run = execute(
      plan,
      { s: [rows[0] as never] },
      { now: NOW, tz: 'Asia/Tokyo', locale: 'de', syncRunId: 'r7' },
    )
    expect(written(run)).toEqual({ a: 'x', who: 'de|Asia/Tokyo|r7|test@1', d: '2026-10-05' })
  })

  it('rejects a `now` that is not an ISO instant', () => {
    expect(() => execute(plan, {}, { now: 'yesterday' })).toThrow(
      "run.now 'yesterday' is not an ISO instant",
    )
  })
})

describe('execution', () => {
  it('runs every node, writes sinks, reports metrics and per-node statistics', () => {
    let tick = 0
    const run = execute(
      planOf(basic(), { targets }),
      { s: rows },
      { now: NOW },
      { clock: () => (tick += 5) },
    )
    expect(run.status).toBe('ok')
    expect(run.sinks).toEqual([
      {
        sink: 'out',
        status: 'write',
        write: {
          sink: 'out',
          target: 't',
          key: ['a'],
          rows: [
            { a: 'x', n: 1 },
            { a: 'y', n: null },
          ],
        },
      },
    ])
    expect(run.metrics).toEqual([{ node: 'met', name: 'rows', rows: [{ n: 2 }] }])
    expect(run.stats).toEqual([
      {
        node: 's',
        op: 'source',
        status: 'ok',
        rowsIn: 0,
        rowsOut: 2,
        skipped: 0,
        changed: 0,
        ms: 5,
      },
      { node: 'm', op: 'map', status: 'ok', rowsIn: 2, rowsOut: 2, skipped: 0, changed: 0, ms: 5 },
      {
        node: 'out',
        op: 'sink',
        status: 'ok',
        rowsIn: 2,
        rowsOut: 2,
        skipped: 0,
        changed: 0,
        ms: 5,
      },
      {
        node: 'g',
        op: 'aggregate',
        status: 'ok',
        rowsIn: 2,
        rowsOut: 1,
        skipped: 0,
        changed: 0,
        ms: 5,
      },
      {
        node: 'met',
        op: 'metrics',
        status: 'ok',
        rowsIn: 1,
        rowsOut: 1,
        skipped: 0,
        changed: 0,
        ms: 5,
      },
    ])
    expect(run.outputs).toBeUndefined()
  })

  it('keeps every output with retain, and frees edges safely without it', () => {
    const plan = planOf(basic(), { targets })
    expect(Object.keys(runOf(plan, { s: rows }).outputs ?? {})).toEqual([
      's',
      'm',
      'out',
      'g',
      'met',
    ])
    // `s` feeds both `m` and `g`; freeing it after `m` would break `g`.
    expect(execute(plan, { s: rows }, { now: NOW }).metrics[0]?.rows).toEqual([{ n: 2 }])
  })

  it('treats a missing source as empty', () => {
    expect(runOf(planOf(basic(), { targets }), {}).metrics[0]?.rows).toEqual([{ n: 0 }])
  })

  it('fails a node, skips what depends on it, and lets independent branches write', () => {
    const plan = planOf(
      v([
        source(),
        source('s2'),
        {
          id: 'j',
          op: 'join',
          left: 's',
          right: 's2',
          on: [['n', 'k']],
          type: 'left',
          cardinality: 'n:1',
        },
        { id: 'mj', op: 'map', in: 'j', fields: [extract('a')] },
        { id: 'out', op: 'sink', in: 'mj', target: 't', key: ['a'] },
        { id: 'map2', op: 'map', in: 's', fields: [extract('a')] },
        { id: 'out2', op: 'sink', in: 'map2', target: 'u', key: ['a'] },
      ]),
      { targets },
    )
    const run = runOf(plan, { s: rows, s2: [{ k: 1 }, { k: 1 }] })
    expect(run.status).toBe('partial')
    expect(run.stats.map((s) => [s.node, s.status])).toEqual([
      ['s', 'ok'],
      ['s2', 'ok'],
      ['j', 'failed'],
      ['mj', 'upstream_failed'],
      ['out', 'upstream_failed'],
      ['map2', 'ok'],
      ['out2', 'ok'],
    ])
    expect(run.sinks.map((s) => [s.sink, s.status])).toEqual([
      ['out', 'upstream_failed'],
      ['out2', 'write'],
    ])
    expect(run.issues).toEqual([
      expect.objectContaining({ node: 'j', code: 'cardinality_violated', samples: [[1]] }),
    ])
  })

  it('reports a sink that fails itself as failed', () => {
    const run = runOf(planOf(basic(), { targets }), { s: [rows[0] as never, rows[0] as never] })
    expect(run.status).toBe('partial')
    expect(run.sinks).toEqual([{ sink: 'out', status: 'failed' }])
    expect(run.issues).toEqual([
      { node: 'out', code: 'duplicate_key', message: 'a ["x"] is written twice', samples: [['x']] },
    ])
  })

  it('stops on fail_sync: no sink writes, but nodes feeding metrics still run', () => {
    const plan = planOf(
      v([
        source(),
        {
          id: 'm',
          op: 'map',
          in: 's',
          on_error: 'fail_sync',
          fields: [
            extract('a'),
            {
              key: 'n',
              pipeline: [
                { op: 'extract', path: 'a' },
                { op: 'to_number', strict: true },
              ],
            },
          ],
        },
        { id: 'out', op: 'sink', in: 'm', target: 't', key: ['a'] },
        count('g', 's'),
        { id: 'met', op: 'metrics', in: 'g', name: 'rows' },
        { id: 'map2', op: 'map', in: 's', fields: [extract('a')] },
        { id: 'out2', op: 'sink', in: 'map2', target: 'u', key: ['a'] },
      ]),
      { targets },
    )
    const run = runOf(plan, { s: rows })
    expect(run.status).toBe('stopped')
    expect(run.sinks).toEqual([
      { sink: 'out', status: 'stopped' },
      { sink: 'out2', status: 'stopped' },
    ])
    expect(run.metrics).toEqual([{ node: 'met', name: 'rows', rows: [{ n: 2 }] }])
    expect(run.stats.map((s) => [s.node, s.status])).toEqual([
      ['s', 'ok'],
      ['m', 'failed'],
      ['out', 'stopped'],
      ['g', 'ok'],
      ['met', 'ok'],
      ['map2', 'stopped'],
      ['out2', 'stopped'],
    ])
    expect(run.issues).toEqual([
      expect.objectContaining({
        node: 'm',
        code: 'parse_failed',
        message: "n step 1 to_number: 'x' is not a number",
      }),
    ])
  })

  it('after a stop, keeps running only what feeds metrics', () => {
    const plan = planOf(
      v(
        [
          source(),
          { id: 'f', op: 'filter', in: 's', cond: { path: 'a', eq: 'x' } },
          count('g', 'f'),
          { id: 'met', op: 'metrics', in: 'g', name: 'rows' },
          { id: 'm', op: 'map', in: 's', fields: [extract('a')] },
          { id: 'out', op: 'sink', in: 'm', target: 'u', key: ['a'] },
        ],
        { expect: { s: { count: { max: 1 }, onFail: 'stop' } } },
      ),
      { targets },
    )
    const run = runOf(plan, { s: rows })
    expect(run.status).toBe('stopped')
    expect(run.stats.map((s) => [s.node, s.status])).toEqual([
      ['s', 'ok'],
      ['f', 'ok'],
      ['g', 'ok'],
      ['met', 'ok'],
      ['m', 'stopped'],
      ['out', 'stopped'],
    ])
  })
})

describe('expectations during a run', () => {
  const guarded = (expect: MappingVersionInput['expect']) => planOf(basic({ expect }), { targets })

  it('stops on a production count envelope, but not in fixture mode', () => {
    const plan = guarded({ m: { count: { min: 100 }, onFail: 'stop' } })
    expect(runOf(plan, { s: rows }).status).toBe('stopped')
    const fixture = runOf(plan, { s: rows }, { fixture: true })
    expect(fixture.status).toBe('ok')
    expect(fixture.issues).toEqual([])
  })

  it('runs every node in fixture mode even after a stop', () => {
    const plan = guarded({ s: { unique: ['n'], onFail: 'stop' } })
    const run = runOf(plan, { s: [...rows, { a: 'z', n: 1 }] }, { fixture: true })
    expect(run.status).toBe('stopped')
    expect(run.stats.every((s) => s.status === 'ok')).toBe(true)
    expect(run.sinks).toEqual([{ sink: 'out', status: 'stopped' }])
  })

  it('compares counts with the baseline the host passes', () => {
    const plan = guarded({ s: { count: { shiftRatio: { max: 1.5 } } } })
    expect(runOf(plan, { s: rows }).issues).toEqual([])
    const run = execute(plan, { s: rows }, { now: NOW, baseline: { s: 1 } })
    expect(run.issues).toEqual([
      expect.objectContaining({
        node: 's',
        clause: 'count',
        action: 'alert',
        message: 'count 2 is 2.00x the baseline 1',
      }),
    ])
    expect(run.status).toBe('ok')
  })

  it('repairs rows before consumers read them and counts the change', () => {
    const plan = guarded({
      m: { rows: { cond: { path: 'n', is_null: false } }, onFail: 'drop_rows' },
    })
    const run = runOf(plan, { s: rows })
    expect(run.sinks[0]?.write?.rows).toEqual([{ a: 'x', n: 1 }])
    expect(run.stats.find((s) => s.node === 'm')).toMatchObject({ rowsOut: 1, changed: 1 })
  })

  it('holds back the sinks below a skip_downstream breach', () => {
    const run = runOf(guarded({ m: { unique: ['n'], onFail: 'skip_downstream' } }), {
      s: [
        { a: 'x', n: 1 },
        { a: 'y', n: 1 },
      ],
    })
    expect(run.status).toBe('partial')
    expect(run.sinks).toEqual([{ sink: 'out', status: 'held' }])
    expect(run.metrics).toHaveLength(1)
  })
})
