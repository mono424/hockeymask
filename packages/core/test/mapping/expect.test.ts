import { describe, expect, it } from 'vite-plus/test'
import type { Action, NodeExpectation } from '../../src/mapping/document'
import { execute } from '../../src/mapping/execute'
import {
  actionName,
  applyViolations,
  countViolation,
  keyedViolations,
  resolveAction,
  uniqueViolation,
} from '../../src/mapping/expect'
import { issuesOf, NOW, planOf, runOf, schemaOf, targetsOf, versionOf } from './helpers'

const rows = [
  { a: 'x', n: 1, k: 'p' },
  { a: 'x', n: 2, k: 'q' },
  { a: 'y', n: null, k: null },
]
const targets = targetsOf({ t: { a: 'string', n: 'decimal?', k: 'string?' } })

/** Source `s` with an expectation, read by a metrics node and (optionally) a sink. */
function graph(exp: NodeExpectation, sink = false) {
  return versionOf({
    expectedSchema: { s: schemaOf({ a: 'string', n: 'number?', k: 'string?' }) },
    nodes: [
      { id: 's', op: 'source', system: 'x', entity: 'y' },
      { id: 'out', op: 'metrics', in: 's', name: 'm' },
      ...(sink
        ? [
            { id: 'd', op: 'distinct', in: 's', keys: ['a'] },
            { id: 'w', op: 'sink', in: 'd', target: 't', key: ['a'] },
          ]
        : []),
    ],
    expect: { s: exp },
  })
}
const run = (exp: NodeExpectation, input = rows, options = {}) =>
  runOf(planOf(graph(exp)), { s: input }, options)
const messages = (exp: NodeExpectation, sink = false) =>
  issuesOf(graph(exp, sink), { targets }).map(({ code, message, field, node }) => ({
    code,
    message,
    field,
    node,
  }))

const CLAUSES: Record<string, NodeExpectation> = {
  count: { count: { max: 1 } },
  unique: { unique: ['a'] },
  keyed: { keyed: { by: 'a', value: 'n', bounds: { x: { max: 0 } } } },
  rows: { rows: { cond: { path: 'n', is_null: false } } },
}
const ACTIONS: [string, Action][] = [
  ['alert', 'alert'],
  ['drop_rows', 'drop_rows'],
  ['set_null', { set_null: ['n'] }],
  ['set_default', { set_default: { n: 0 } }],
  ['skip_downstream', 'skip_downstream'],
  ['stop', 'stop'],
]
const VALID: Record<string, string[]> = {
  count: ['alert', 'skip_downstream', 'stop'],
  unique: ['alert', 'drop_rows', 'skip_downstream', 'stop'],
  keyed: ['alert', 'skip_downstream', 'stop'],
  rows: ['alert', 'drop_rows', 'set_null', 'set_default', 'skip_downstream', 'stop'],
}

describe('actions per clause', () => {
  for (const [clause, exp] of Object.entries(CLAUSES)) {
    it.each(ACTIONS)(`${clause} with %s`, (name, action) => {
      const issues = messages({ ...exp, onFail: action })
      if (VALID[clause]?.includes(name)) {
        expect(issues).toEqual([])
        const result = run({ ...exp, onFail: action })
        expect(result.issues).toEqual([expect.objectContaining({ clause, action })])
        expect(result.status).toBe(name === 'stop' ? 'stopped' : 'ok')
      } else {
        expect(issues).toEqual([
          {
            code: 'invalid_expectation',
            message: `action ${name} does not apply to ${clause}`,
            field: clause,
            node: 's',
          },
        ])
      }
    })
  }
})

describe('effects', () => {
  it('alert reports and changes nothing', () => {
    const result = run({ unique: ['a'] })
    expect(result.outputs?.s).toHaveLength(3)
    expect(result.issues).toEqual([
      {
        node: 's',
        code: 'expectation',
        clause: 'unique',
        action: 'alert',
        message: 'a not unique: 1 duplicated keys',
        count: 1,
        samples: [['x']],
      },
    ])
  })

  it('drop_rows on unique drops every row sharing a key; on rows the violating rows', () => {
    expect(run({ unique: ['a'], onFail: 'drop_rows' }).outputs?.s).toEqual([rows[2]])
    const result = run({ rows: { cond: { path: 'n', is_null: false } }, onFail: 'drop_rows' })
    expect(result.outputs?.s).toEqual(rows.slice(0, 2))
    expect(result.stats[0]?.changed).toBe(1)
    expect(result.issues[0]).toMatchObject({
      rowsAffected: 1,
      samples: [{ a: 'y', n: null, k: null }],
    })
  })

  it('set_null and set_default repair the violating rows', () => {
    const cond = { path: 'a', eq: 'y' }
    expect(run({ rows: { cond }, onFail: { set_null: ['a'] } }).outputs?.s?.slice(0, 2)).toEqual([
      { a: null, n: 1, k: 'p' },
      { a: null, n: 2, k: 'q' },
    ])
    const fixed = run({
      rows: { cond: { path: 'n', is_null: false } },
      onFail: { set_default: { n: 0 } },
    })
    expect(fixed.outputs?.s?.[2]).toEqual({ a: 'y', n: 0, k: null })
    expect(fixed.issues[0]).toMatchObject({ rowsAffected: 1 })
  })

  it('skip_downstream holds the sinks below the node', () => {
    const plan = planOf(graph({ count: { max: 1 }, onFail: 'skip_downstream' }, true), { targets })
    const result = runOf(plan, { s: rows })
    expect(result.sinks).toEqual([{ sink: 'w', status: 'held' }])
    expect(result.status).toBe('partial')
  })

  it('drops first, then repairs what is left, whatever the clause order', () => {
    const exp = {
      rows: { cond: { path: 'n', gt: 1 } },
      unique: ['a'],
      onFail: { unique: 'drop_rows', rows: { set_null: ['k'] } },
    } as NodeExpectation
    const result = run(exp)
    expect(result.outputs?.s).toEqual([{ a: 'y', n: null, k: null }])
    expect(result.issues.map((i) => [i.clause, i.rowsAffected])).toEqual([
      ['unique', 2],
      ['rows', 1],
    ])
  })
})

describe('typed repairs', () => {
  it('set_null widens the field, so a sink that needs it non-null fails at save', () => {
    const exp: NodeExpectation = {
      rows: { cond: { path: 'a', eq: 'x' } },
      onFail: { set_null: ['a'] },
    }
    expect(messages(exp, true)).toEqual([
      { code: 'type_error', message: 'a expects string, got string?', field: 'a', node: 's' },
      {
        code: 'type_error',
        message: "key 'a' must be non-null, got string?",
        field: undefined,
        node: 'w',
      },
    ])
  })

  it.each([
    [{ set_null: ['zz'] }, 'set_null names unknown fields: zz'],
    [{ set_default: { zz: 1 } }, 'set_default names unknown fields: zz'],
    [{ set_default: { n: 'x' } }, 'set_default n: "x" is not a number'],
    [{ set_default: { n: null } }, 'set_default n: null is not a number'],
  ] as [Action, string][])('rejects %j', (onFail, message) => {
    expect(messages({ rows: { cond: { path: 'a', eq: 'x' } }, onFail })).toEqual([
      { code: 'invalid_expectation', message, field: 'rows', node: 's' },
    ])
  })
})

describe('clause checks at save', () => {
  it.each([
    [{ unique: ['zz'] }, 'unique', 'unknown fields: zz'],
    [{ keyed: { by: 'zz', value: 'n', bounds: {} } }, 'keyed', 'unknown fields: zz'],
    [{ keyed: { by: 'a', value: 'k', bounds: {} } }, 'keyed', 'k must be a number'],
    [
      { keyed: { by: 'a', value: 'n', bounds: { x: { max: 1, onFail: 'drop_rows' } } } },
      'keyed',
      'action drop_rows does not apply to keyed',
    ],
    [
      { rows: { cond: { eq: 1 } } },
      'rows',
      'this condition has no piped value to test; give it a "path"',
    ],
  ] as [NodeExpectation, string, string][])('%j', (exp, field, message) => {
    expect(messages(exp)).toEqual([{ code: 'invalid_expectation', message, field, node: 's' }])
  })
})

describe('count', () => {
  it('checks min and max, skipped in fixture runs', () => {
    expect(run({ count: { min: 5 } }).issues[0]?.message).toBe('count 3 below 5')
    expect(run({ count: { min: 5 } }, rows, { fixture: true }).issues).toEqual([])
    expect(run({ count: { min: 1, max: 5 } }).issues).toEqual([])
  })

  it('checks shiftRatio only against a positive baseline', () => {
    const plan = planOf(graph({ count: { shiftRatio: { min: 0.5, max: 1.5 } } }))
    const at = (baseline?: number) =>
      execute(
        plan,
        { s: rows },
        { now: NOW, ...(baseline === undefined ? {} : { baseline: { s: baseline } }) },
      ).issues
    expect(at()).toEqual([])
    expect(at(0)).toEqual([])
    expect(at(3)).toEqual([])
    expect(at(1)[0]?.message).toBe('count 3 is 3.00x the baseline 1')
    expect(at(10)[0]?.message).toBe('count 3 is 0.30x the baseline 10')
    expect(countViolation(3, { shiftRatio: { max: 2 } }, 'alert', 6)).toBeUndefined()
    expect(countViolation(3, { shiftRatio: { min: 2 } }, 'alert', 6)?.message).toBe(
      'count 3 is 0.50x the baseline 6',
    )
  })
})

describe('keyed', () => {
  const counters = [
    { kind: 'a', rows: 3 },
    { kind: 'b', rows: null },
    { kind: 'a', rows: 99 },
  ]
  const keyed = (bounds: Record<string, object>) => ({ by: 'kind', value: 'rows', bounds })

  it('reads the first row per key; a missing key or null value counts as 0', () => {
    const v = keyedViolations(
      counters,
      keyed({ a: { max: 2 }, b: { min: 1 }, c: { min: 1 }, d: { max: 0 } }),
      undefined,
    )
    expect(v.map((x) => x.message)).toEqual([
      'kind a: rows 3 above 2',
      'kind b: rows 0 below 1',
      'kind c: rows 0 below 1',
    ])
  })

  it('keys non-string values by their JSON form', () => {
    const v = keyedViolations([{ kind: 7, rows: 1 }], keyed({ 7: { max: 0 } }), 'stop')
    expect(v).toEqual([
      {
        clause: 'keyed',
        action: 'stop',
        message: 'kind 7: rows 1 above 0',
        count: 1,
        samples: ['7'],
      },
    ])
  })

  it('runs in an expectation, per-bound action first', () => {
    const exp: NodeExpectation = {
      keyed: {
        by: 'a',
        value: 'n',
        bounds: { x: { max: 0, onFail: 'skip_downstream' }, y: { min: 1 } },
      },
      onFail: 'stop',
    }
    expect(run(exp).issues.map((i) => i.action)).toEqual(['skip_downstream', 'stop'])
  })
})

describe('resolveAction', () => {
  it.each([
    [undefined, undefined, 'alert'],
    ['stop', undefined, 'stop'],
    [{ set_null: ['a'] }, undefined, { set_null: ['a'] }],
    [{ set_default: { a: 1 } }, undefined, { set_default: { a: 1 } }],
    [{ rows: 'stop', default: 'drop_rows' }, undefined, 'stop'],
    [{ count: 'stop', default: 'drop_rows' }, undefined, 'drop_rows'],
    [{ count: 'stop' }, undefined, 'alert'],
    [{ rows: 'stop' }, 'skip_downstream', 'skip_downstream'],
  ] as const)('%j with own %j', (spec, own, action) => {
    expect(resolveAction(spec as never, 'rows', own)).toEqual(action)
  })

  it('names actions', () => {
    expect([
      actionName('stop'),
      actionName({ set_null: [] }),
      actionName({ set_default: {} }),
    ]).toEqual(['stop', 'set_null', 'set_default'])
  })
})

describe('row and key reads', () => {
  it('a passing rows clause reports nothing', () => {
    expect(run({ rows: { cond: { path: 'a', is_null: false } } }).issues).toEqual([])
  })

  it('absent fields read as null', () => {
    expect(uniqueViolation([{}, {}], ['a'], 'alert')?.samples).toEqual([[null]])
    expect(
      keyedViolations(
        [{ rows: 1 }],
        { by: 'kind', value: 'rows', bounds: { null: { max: 0 } } },
        undefined,
      ),
    ).toHaveLength(1)
  })
})

describe('applyViolations', () => {
  const base = { clause: 'rows', message: 'm', count: 1, samples: [] }
  it('merges repairs of one row and tolerates violations without rows', () => {
    const out = applyViolations(
      'n',
      'c',
      [{ a: 1, b: 2 }],
      [
        { ...base, action: { set_null: ['a'] }, rows: [0] },
        { ...base, action: { set_default: { b: 0 } }, rows: [0] },
        { ...base, action: 'drop_rows' },
        { ...base, action: { set_null: ['b'] } },
      ],
    )
    expect(out.rows).toEqual([{ a: null, b: 0 }])
    expect(out.changed).toBe(1)
    expect(out.issues.map((i) => i.rowsAffected)).toEqual([1, 1, 0, 0])
  })
})
