import { describe, expect, it } from 'vite-plus/test'
import { show } from '../../../src/mapping/types'
import { issuesOf, planOf, runOf, schemaOf, versionOf } from '../helpers'
import { messagesOf, single } from './util'

describe('source', () => {
  it('needs an expectedSchema entry', () => {
    const version = versionOf({
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'y' },
        { id: 'out', op: 'metrics', in: 's', name: 'm' },
      ],
    })
    expect(issuesOf(version)).toEqual([
      { code: 'missing_schema', message: "no expectedSchema for source 's'", node: 's' },
    ])
  })

  it('needs an object schema', () => {
    const version = versionOf({
      expectedSchema: { s: { type: 'string' } },
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'y' },
        { id: 'out', op: 'metrics', in: 's', name: 'm' },
      ],
    })
    expect(issuesOf(version)[0]).toMatchObject({ code: 'missing_schema', node: 's' })
  })

  it('rejects unknown params and a bad filter', () => {
    const version = versionOf({
      expectedSchema: { s: schemaOf({ a: 'string' }) },
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'y', extra: 1 },
        { id: 'out', op: 'metrics', in: 's', name: 'm' },
      ],
    })
    expect(issuesOf(version)[0]).toMatchObject({ code: 'invalid_params', node: 's' })
    expect(messagesOf({ op: 'filter', cond: { path: 'a', eq: 'x' } }, { a: 'string' })).toEqual([])
    const filtered = versionOf({
      expectedSchema: { s: schemaOf({ a: 'string' }) },
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'y', filter: { path: 'nope', eq: 1 } },
        { id: 'out', op: 'metrics', in: 's', name: 'm' },
      ],
    })
    expect(issuesOf(filtered)[0]?.message).toMatch(/^filter: unknown field 'nope'/)
  })

  const filtered = (filter?: unknown) =>
    versionOf({
      expectedSchema: { s: schemaOf({ a: 'string', b: 'number?' }) },
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'y', ...(filter ? { filter } : {}) },
        { id: 'out', op: 'metrics', in: 's', name: 'm' },
      ],
    })

  it('loads rows projected onto the declared fields; a missing snapshot is empty', () => {
    const plan = planOf(filtered())
    expect(runOf(plan, { s: [{ a: 'x', extra: 1 }] }).outputs?.s).toEqual([{ a: 'x', b: null }])
    expect(runOf(plan, {}).outputs?.s).toEqual([])
  })

  it('pushes a filter into the read and narrows is_null: false fields', () => {
    const plan = planOf(filtered({ path: 'b', is_null: false }))
    expect(show(plan.nodes[0]?.output?.type as never)).toBe('{ a: string, b: number }')
    expect(runOf(plan, { s: [{ a: 'x', b: 1 }, { a: 'y' }] }).outputs?.s).toEqual([
      { a: 'x', b: 1 },
    ])
  })

  it('fails on values of the wrong type, one issue per field', () => {
    const run = runOf(planOf(filtered()), { s: [{ a: 1, b: 'x' }, { a: 2 }] })
    expect(run.stats[0]?.status).toBe('failed')
    expect(run.issues).toEqual([
      { node: 's', code: 'schema_violation', message: '2 fields do not match the declared schema' },
      {
        node: 's',
        code: 'schema_violation',
        field: 'a',
        message: 'a: 2 values are not string',
        count: 2,
        samples: [0, 1],
      },
      {
        node: 's',
        code: 'schema_violation',
        field: 'b',
        message: 'b: 1 values are not number?',
        count: 1,
        samples: [0],
      },
    ])
  })

  it('is a source in the catalog with no input slots', () => {
    expect(
      single({ op: 'filter', cond: { path: 'a', eq: 'x' } }, { a: 'string' }).nodes[0],
    ).toEqual({
      id: 's',
      op: 'source',
      system: 'x',
      entity: 'y',
    })
  })
})
