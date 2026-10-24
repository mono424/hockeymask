import { describe, expect, it } from 'vite-plus/test'
import { emptyVersion, parseVersion, versionJsonSchema } from '../../src/mapping/document'

describe('parseVersion', () => {
  it('fills in defaults', () => {
    expect(parseVersion({ id: 'v' })).toEqual({
      id: 'v',
      version: 1,
      status: 'draft',
      params: {},
      tables: {},
      expectedSchema: {},
      nodes: [],
      expect: {},
      examples: [],
    })
  })

  it('keeps node params it does not know, and example defaults', () => {
    const version = parseVersion({
      id: 'v',
      nodes: [{ id: 'm', op: 'map', in: 's', fields: [] }],
      examples: [{ name: 'e' }],
      layout: { m: { x: 1, y: 2 } },
    })
    expect(version.nodes).toEqual([{ id: 'm', op: 'map', in: 's', fields: [] }])
    expect(version.examples).toEqual([{ name: 'e', sources: {}, expect: {} }])
    expect(version.layout).toEqual({ m: { x: 1, y: 2 } })
  })

  it('accepts every action form', () => {
    const version = parseVersion({
      id: 'v',
      expect: {
        a: { count: { min: 1, shiftRatio: { max: 2 } }, onFail: 'stop' },
        b: { rows: { cond: { path: 'x', eq: 1 } }, onFail: { set_null: ['x'] } },
        c: { rows: { cond: {} }, onFail: { set_default: { x: 0 } } },
        d: {
          unique: ['x'],
          keyed: { by: 'k', value: 'n', bounds: { z: { max: 0, onFail: 'alert' } } },
          onFail: { default: 'alert', unique: 'drop_rows' },
          note: 'n',
        },
      },
    })
    expect(Object.keys(version.expect)).toEqual(['a', 'b', 'c', 'd'])
  })

  it.each([
    ['a missing id', {}],
    ['a node without op', { id: 'v', nodes: [{ id: 'n' }] }],
    ['an unknown expectation clause', { id: 'v', expect: { n: { counts: {} } } }],
    ['an unknown action', { id: 'v', expect: { n: { unique: ['x'], onFail: 'explode' } } }],
    [
      'an empty set_null',
      { id: 'v', expect: { n: { rows: { cond: {} }, onFail: { set_null: [] } } } },
    ],
    ['an unknown example key', { id: 'v', examples: [{ sourcez: {} }] }],
    ['a bad on_error default', { id: 'v', onError: 'explode' }],
    ['a non-JSON param', { id: 'v', params: { x: undefined } }],
  ])('rejects %s', (_name, input) => {
    expect(() => parseVersion(input)).toThrow()
  })
})

it('emptyVersion is a parsed version with an optional name', () => {
  expect(emptyVersion('v', 'Items')).toMatchObject({ id: 'v', name: 'Items', nodes: [] })
  expect(emptyVersion('v')).not.toHaveProperty('name')
})

it('versionJsonSchema describes the document for tools and models', () => {
  const schema = versionJsonSchema()
  expect(schema.type).toBe('object')
  expect(schema.required).toEqual(['id'])
  expect(Object.keys(schema.properties as object)).toContain('nodes')
})
