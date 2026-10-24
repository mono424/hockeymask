import { describe, expect, it } from 'vite-plus/test'
import { show } from '../../../src/mapping/types'
import { issuesOf, planOf, runOf, targetsOf } from '../helpers'
import { messagesOf, outputAt, outputOf, single } from './util'

const fields = { a: 'string', b: 'number?', s: 'string' } as const
const extract = (path: string) => [{ op: 'extract', path }]
const strict = [
  { op: 'extract', path: 's' },
  { op: 'to_number', strict: true },
]
const map = (f: Record<string, unknown[]>, extra: Record<string, unknown> = {}) => ({
  op: 'map',
  fields: Object.entries(f).map(([key, pipeline]) => ({ key, pipeline })),
  ...extra,
})
const outputType = (node: Record<string, unknown>, extra = {}) =>
  show(outputAt(planOf(single(node, fields, extra))).type)
const origins = (node: Record<string, unknown>, extra = {}) =>
  outputAt(planOf(single(node, fields, extra))).origins

describe('map', () => {
  it('computes one field per pipeline', () => {
    const rows = [{ a: 'x', b: 2, s: '1' }]
    expect(outputOf(map({ k: extract('a'), n: strict }), fields, rows)).toEqual([{ k: 'x', n: 1 }])
  })

  it('keeps input fields with keep: "all", minus drop', () => {
    const node = map({ n: strict }, { keep: 'all', drop: ['s'] })
    expect(outputType(node)).toBe('{ a: string, b: number?, n: number }')
    expect(outputOf(node, fields, [{ a: 'x', s: '3' }])).toEqual([{ a: 'x', b: null, n: 3 }])
    expect(origins(node).a).toEqual({ node: 's', field: 'a', omittable: false })
  })

  it('rejects drop without keep, unknown drops, duplicate keys and bad pipelines', () => {
    expect(messagesOf(map({ k: extract('a') }, { drop: ['a'] }), fields)).toEqual([
      'drop applies only with keep: "all"',
    ])
    expect(messagesOf(map({ k: extract('a') }, { keep: 'all', drop: ['z'] }), fields)).toEqual([
      "drop: unknown field 'z'",
    ])
    const twice = {
      op: 'map',
      fields: [
        { key: 'k', pipeline: extract('a') },
        { key: 'k', pipeline: extract('a') },
      ],
    }
    expect(messagesOf(twice, fields)).toEqual(["field 'k' is defined twice"])
    expect(
      issuesOf(single(map({ k: [...extract('a'), { op: 'divide', by: 2 }] }), fields)),
    ).toEqual([
      {
        code: 'type_error',
        message: 'divide expects number, got string',
        node: 'n',
        field: 'k',
        step: 1,
      },
    ])
  })

  it('omit_if_null leaves the field out, even over a kept field of the same name', () => {
    const node = map({ b: [...extract('b'), { op: 'omit_if_null' }] }, { keep: 'all' })
    expect(
      outputOf(node, fields, [
        { a: 'x', b: null, s: '' },
        { a: 'y', b: 1, s: '' },
      ]),
    ).toEqual([
      { a: 'x', s: '' },
      { a: 'y', b: 1, s: '' },
    ])
    expect(origins(node).b).toEqual({
      node: 'n',
      field: 'b',
      omittable: true,
      present: { kind: 'number' },
    })
  })

  it('keep: "all" keeps an absent upstream field absent', () => {
    const upstream = {
      id: 'u',
      op: 'map',
      in: 's',
      fields: [{ key: 'b', pipeline: [...extract('b'), { op: 'omit_if_null' }] }],
    }
    const node = map({ c: [{ op: 'const', value: 1 }] }, { in: 'u', keep: 'all' })
    expect(outputOf(node, fields, [{ a: 'x', s: '' }], { nodes: [upstream] })).toEqual([{ c: 1 }])
  })

  describe('on_error', () => {
    const bad = Array.from({ length: 7 }, (_, i) => ({ a: `x${i}`, s: 'n/a' }))
    const rows = [{ a: 'ok', s: '5' }, ...bad]

    it('skip_record (default) drops the record and reports the failures once, with samples', () => {
      const plan = planOf(single(map({ k: extract('a'), n: strict }), fields))
      const run = runOf(plan, { s: rows })
      expect(run.outputs?.n).toEqual([{ k: 'ok', n: 5 }])
      expect(run.stats[1]).toMatchObject({ node: 'n', rowsIn: 8, rowsOut: 1, skipped: 7 })
      expect(run.issues).toEqual([
        {
          node: 'n',
          code: 'parse_failed',
          field: 'n',
          message: 'n: 7 records failed (skip_record)',
          count: 7,
          samples: Array(5).fill("step 1 to_number: 'n/a' is not a number"),
        },
      ])
      expect(plan.nodes[1]?.output?.canSkip).toBe(true)
    })

    it('null writes null and makes the field nullable', () => {
      const node = map({ k: extract('a'), n: strict }, { on_error: 'null' })
      expect(outputType(node)).toBe('{ k: string, n: number? }')
      expect(outputOf(node, fields, rows.slice(0, 2))).toEqual([
        { k: 'ok', n: 5 },
        { k: 'x0', n: null },
      ])
    })

    it('skip_field leaves the field out and marks it omittable', () => {
      const node = map({ k: extract('a'), n: strict }, { on_error: 'skip_field' })
      expect(outputOf(node, fields, rows.slice(0, 2))).toEqual([{ k: 'ok', n: 5 }, { k: 'x0' }])
      expect(origins(node).n).toEqual({
        node: 'n',
        field: 'n',
        omittable: true,
        present: { kind: 'number' },
      })
    })

    it('the version onError is the default', () => {
      expect(outputType(map({ n: strict }), { onError: 'null' })).toBe('{ n: number? }')
    })

    it('fail_sync fails the node and stops the run', () => {
      const version = single(map({ n: strict }, { on_error: 'fail_sync' }), fields, {
        nodes: [{ id: 'w', op: 'sink', in: 'n', target: 't', key: ['n'] }],
      })
      const run = runOf(planOf(version, { targets: targetsOf({ t: { n: 'decimal' } }) }), {
        s: rows,
      })
      expect(run.status).toBe('stopped')
      expect(run.issues).toEqual([
        { node: 'n', code: 'parse_failed', message: "n step 1 to_number: 'n/a' is not a number" },
      ])
      expect(run.sinks).toEqual([{ sink: 'w', status: 'stopped' }])
    })
  })
})
