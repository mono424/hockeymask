import { describe, expect, it } from 'vite-plus/test'
import { issuesOf, planOf, runOf, schemaOf, versionOf } from '../helpers'

describe('metrics', () => {
  it('reports its input, sorted, as JSON on the run', () => {
    const version = versionOf({
      expectedSchema: { s: schemaOf({ a: 'string', n: 'number' }) },
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'y' },
        { id: 'out', op: 'metrics', in: 's', name: 'counts' },
      ],
    })
    const run = runOf(planOf(version), {
      s: [
        { a: 'b', n: 2 },
        { a: 'a', n: 1 },
      ],
    })
    expect(run.metrics).toEqual([
      {
        node: 'out',
        name: 'counts',
        rows: [
          { a: 'a', n: 1 },
          { a: 'b', n: 2 },
        ],
      },
    ])
    expect(run.outputs?.out).toEqual([
      { a: 'a', n: 1 },
      { a: 'b', n: 2 },
    ])
  })

  // `rows` in the source only so that count_by can be asked to group on it.
  const kinds = (node: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    versionOf({
      expectedSchema: { s: schemaOf({ kind: 'string?', rows: 'number' }) },
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'y' },
        { id: 'out', op: 'metrics', in: 's', name: 'kinds', ...node },
      ],
      ...extra,
    })
  const source = [{ kind: 'store' }, { kind: null }, { kind: 'online' }, { kind: 'store' }].map(
    (r) => ({ ...r, rows: 0 }),
  )

  it('counts rows per count_by group, null being a group of its own', () => {
    const run = runOf(planOf(kinds({ count_by: ['kind'] })), { s: source })
    expect(run.metrics[0]?.rows).toEqual([
      { kind: null, rows: 1 },
      { kind: 'online', rows: 1 },
      { kind: 'store', rows: 2 },
    ])
  })

  it('rejects unknown count_by fields and one named like the count', () => {
    expect(issuesOf(kinds({ count_by: ['zz', 'yy'] })).map((i) => i.message)).toEqual([
      'count_by: unknown fields: zz, yy',
    ])
    expect(issuesOf(kinds({ count_by: ['rows'] })).map((i) => i.message)).toEqual([
      "count_by: 'rows' is the count field; rename it first",
    ])
  })

  it('takes expectations on what it reports, and reports the rows as checks leave them', () => {
    const run = runOf(
      planOf(
        kinds(
          { count_by: ['kind'] },
          {
            expect: {
              out: {
                keyed: { by: 'kind', value: 'rows', bounds: { online: { max: 0 } } },
                rows: { cond: { path: 'kind', is_null: false } },
                onFail: { rows: 'drop_rows' },
              },
            },
          },
        ),
      ),
      { s: source },
    )
    expect(run.status).toBe('ok')
    expect(run.issues.map((i) => i.message)).toEqual([
      'kind online: rows 1 above 0',
      '1 rows fail the row condition',
    ])
    expect(run.metrics[0]?.rows).toEqual([
      { kind: 'online', rows: 1 },
      { kind: 'store', rows: 2 },
    ])
  })
})
