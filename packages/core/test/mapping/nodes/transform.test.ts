import { describe, expect, it } from 'vite-plus/test'
import type { TransformDef } from '../../../src/mapping/context'
import { err, ok } from '../../../src/mapping/result'
import { schemaOf } from '../helpers'
import { messagesOf, outputOf } from './util'

const schema = schemaOf({ total: 'number' })
const transforms: Record<string, TransformDef> = {
  'sum@1': {
    run: ([rows]) => ok([{ total: (rows ?? []).reduce((n, r) => n + (r.n as number), 0) }]),
  },
  'broken@1': { run: () => err('upstream API is down') },
  'wrong@1': { run: () => ok([{ total: 'many' }]) },
}
const node = (ref: string, extra: Record<string, unknown> = {}) => ({
  op: 'transform',
  ref,
  inputs: ['s'],
  schema,
  ...extra,
})

describe('transform', () => {
  it('runs registered code and types its output from the declared schema', () => {
    const rows = [{ n: 1 }, { n: 2 }]
    expect(outputOf(node('sum@1'), { n: 'number' }, rows, {}, { transforms })).toEqual([
      { total: 3 },
    ])
  })

  it('rejects an unknown ref (with or without a registry) and a bad schema', () => {
    expect(messagesOf(node('nope'), { n: 'number' }, {}, { transforms })).toEqual([
      "unknown transform 'nope'",
    ])
    expect(messagesOf(node('sum@1'), { n: 'number' })).toEqual(["unknown transform 'sum@1'"])
    expect(
      messagesOf(node('sum@1', { schema: { type: 'array' } }), { n: 'number' }, {}, { transforms }),
    ).toEqual([expect.stringMatching(/^schema: a source schema must describe one object record/)])
  })

  it('fails the node when the code fails or returns rows off its schema', async () => {
    const { planOf, runOf } = await import('../helpers')
    const { single } = await import('./util')
    const broken = runOf(planOf(single(node('broken@1'), { n: 'number' }), { transforms }), {
      s: [],
    })
    expect(broken.issues).toEqual([
      { node: 'n', code: 'transform_failed', message: 'upstream API is down' },
    ])
    const wrong = runOf(planOf(single(node('wrong@1'), { n: 'number' }), { transforms }), { s: [] })
    expect(wrong.issues[0]).toMatchObject({ node: 'n', code: 'schema_violation' })
    expect(wrong.stats.find((s) => s.node === 'n')?.status).toBe('failed')
  })
})
