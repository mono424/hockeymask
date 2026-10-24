import { describe, expect, it } from 'vite-plus/test'
import { messagesOf, outputOf } from './util'

const fields = { a: 'string', b: 'number?', c: 'boolean' } as const

describe('distinct', () => {
  it('deduplicates on the keys and projects to them, first occurrence first', () => {
    const rows = [
      { a: 'y', b: 1, c: true },
      { a: 'x', c: false },
      { a: 'y', b: 1, c: false },
      { a: 'x', b: null, c: true },
    ]
    expect(outputOf({ op: 'distinct', keys: ['a', 'b'] }, fields, rows)).toEqual([
      { a: 'y', b: 1 },
      { a: 'x', b: null },
    ])
  })

  it('rejects unknown keys', () => {
    expect(messagesOf({ op: 'distinct', keys: ['a', 'z', 'q'] }, fields)).toEqual([
      'unknown keys: z, q',
    ])
  })
})
