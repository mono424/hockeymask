import { describe, expect, it } from 'vite-plus/test'
import { show } from '../../../src/mapping/types'
import { planOf, runOf, schemaOf, targetsOf, versionOf } from '../helpers'

const map = (id: string, from: string, fields: Record<string, unknown[]>) => ({
  id,
  op: 'map',
  in: from,
  fields: Object.entries(fields).map(([key, pipeline]) => ({ key, pipeline })),
})
const extract = (path: string) => [{ op: 'extract', path }]

function union(
  left: Record<string, unknown[]>,
  right: Record<string, unknown[]>,
  extra: unknown[] = [],
) {
  return versionOf({
    expectedSchema: { s: schemaOf({ a: 'string', b: 'number?', c: 'number' }) },
    nodes: [
      { id: 's', op: 'source', system: 'x', entity: 'y' },
      map('l', 's', left),
      map('r', 's', right),
      { id: 'n', op: 'union', inputs: ['l', 'r'] },
      ...(extra as never[]),
    ],
  })
}

const metrics = [{ id: 'out', op: 'metrics', in: 'n', name: 'm' }]

describe('union', () => {
  it('unions inputs and collapses duplicates', () => {
    const plan = planOf(union({ v: extract('a') }, { v: [{ op: 'const', value: 'k' }] }, metrics))
    const run = runOf(plan, {
      s: [
        { a: 'k', c: 1 },
        { a: 'z', c: 2 },
      ],
    })
    expect(run.outputs?.n).toEqual([{ v: 'k' }, { v: 'z' }])
  })

  it('widens a field nullable in any input', () => {
    const plan = planOf(union({ v: extract('b') }, { v: extract('c') }, metrics))
    expect(show(plan.nodes.find((n) => n.id === 'n')?.output?.type as never)).toBe('{ v: number? }')
  })

  it('needs the same fields and compatible types', () => {
    const fieldsDiffer = planIssues(union({ v: extract('a') }, { w: extract('a') }, metrics))
    expect(fieldsDiffer).toEqual(['r has fields w; l has v'])
    const typesDiffer = planIssues(union({ v: extract('a') }, { v: extract('c') }, metrics))
    expect(typesDiffer).toEqual(['v: r gives number, earlier inputs string'])
  })

  it('stays omittable when an input field is, so a sink skips absent values', () => {
    const omit = [...extract('b'), { op: 'omit_if_null' }]
    const right = { k: [{ op: 'const', value: 'y' }], v: extract('c') }
    const version = union({ k: extract('a'), v: omit }, right, [
      { id: 'w', op: 'sink', in: 'n', target: 't', key: ['k'] },
    ])
    const plan = planOf(version, { targets: targetsOf({ t: { k: 'string', v: 'decimal' } }) })
    const run = runOf(plan, { s: [{ a: 'x', c: 1 }] })
    expect(run.outputs?.w).toEqual([{ k: 'x' }, { k: 'y', v: 1 }])
  })
})

function planIssues(version: ReturnType<typeof versionOf>) {
  try {
    planOf(version)
    return []
  } catch (e) {
    return (JSON.parse((e as Error).message) as { message: string }[]).map((i) => i.message)
  }
}
