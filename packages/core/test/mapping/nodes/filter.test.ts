import { describe, expect, it } from 'vite-plus/test'
import { show } from '../../../src/mapping/types'
import { planOf, targetsOf } from '../helpers'
import { messagesOf, outputOf, single } from './util'

const fields = { a: 'string', b: 'number?' } as const

describe('filter', () => {
  it('keeps records where the condition holds', () => {
    const rows = [
      { a: 'x', b: 1 },
      { a: 'y', b: 2 },
    ]
    expect(outputOf({ op: 'filter', cond: { path: 'b', gt: 1 } }, fields, rows)).toEqual([
      { a: 'y', b: 2 },
    ])
  })

  it('rejects a bad condition', () => {
    expect(messagesOf({ op: 'filter', cond: { eq: 1 } }, fields)).toEqual([
      'cond: this condition has no piped value to test; give it a "path"',
    ])
  })

  it('narrows is_null: false fields, also inside all', () => {
    const cond = {
      all: {
        of: [
          { path: 'a', eq: 'x' },
          { path: 'b', is_null: false },
        ],
      },
    }
    const plan = planOf(single({ op: 'filter', cond }, fields))
    expect(show(plan.nodes[1]?.output?.type as never)).toBe('{ a: string, b: number }')
  })

  it('narrowing an omittable field makes it present, so it can key a sink', () => {
    const version = single({ op: 'filter', in: 'm', cond: { path: 'k', is_null: false } }, fields, {
      nodes: [
        {
          id: 'm',
          op: 'map',
          in: 's',
          fields: [{ key: 'k', pipeline: [{ op: 'extract', path: 'b' }, { op: 'omit_if_null' }] }],
        },
        { id: 'w', op: 'sink', in: 'n', target: 't', key: ['k'] },
      ],
    })
    expect(planOf(version, { targets: targetsOf({ t: { k: 'decimal' } }) }).nodes).toHaveLength(5)
  })
})
