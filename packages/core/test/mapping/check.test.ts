import { describe, expect, it } from 'vite-plus/test'
import { checkVersion, validateStructure } from '../../src/mapping/check'
import type { MappingVersionInput } from '../../src/mapping/document'
import { schemaOf, targetsOf, versionOf } from './helpers'

const targets = targetsOf({ t: { a: 'string', d: 'date?' } })
const env = { targets }

const rows = [{ a: 'x', iso: '2026-10-04T23:30:00Z' }]

type Example = NonNullable<MappingVersionInput['examples']>[number]

/** s -> m (a, d) -> out; `clock` adds a field compared with today. */
function v(
  examples: Example[],
  options: { clock?: boolean; expect?: MappingVersionInput['expect'] } = {},
) {
  return versionOf({
    expectedSchema: { s: schemaOf({ a: 'string', iso: 'string' }) },
    nodes: [
      { id: 's', op: 'source', system: 'x', entity: 'y' },
      {
        id: 'm',
        op: 'map',
        in: 's',
        fields: [
          { key: 'a', pipeline: [{ op: 'extract', path: 'a' }] },
          {
            key: 'd',
            pipeline: [
              { op: 'extract', path: 'iso' },
              { op: 'to_date', format: 'iso' },
              ...(options.clock ? [{ op: 'if_after', date: 'today', then: null }] : []),
            ],
          },
        ],
      },
      { id: 'out', op: 'sink', in: 'm', target: 't', key: ['a'] },
    ],
    examples,
    ...(options.expect ? { expect: options.expect } : {}),
  })
}

describe('checkVersion', () => {
  it('passes a version that compiles and whose examples pass', () => {
    const checked = checkVersion(v([{ sources: { s: rows }, expect: { out: [{ a: 'x' }] } }]), env)
    expect(checked).toMatchObject({ ok: true, issues: [] })
    expect(checked.plan?.nodes).toHaveLength(3)
    expect(checked.examples).toHaveLength(1)
  })

  it('returns compile issues without running examples', () => {
    const checked = checkVersion(v([]), { targets: targetsOf({}) })
    expect(checked.ok).toBe(false)
    expect(checked.issues).toEqual([expect.objectContaining({ code: 'type_error', node: 'out' })])
    expect(checked).not.toHaveProperty('plan')
  })

  it('turns example failures and differences into blocking issues', () => {
    const checked = checkVersion(
      v([
        { name: 'bad', sources: { s: rows }, expect: { m: [{ a: 'y' }] } },
        { sources: { s: rows }, now: 'never' },
      ]),
      env,
    )
    expect(checked.ok).toBe(false)
    expect(checked.issues).toEqual([
      {
        code: 'example_failed',
        node: 'm',
        message: 'example bad: m is missing 1 and has 1 unexpected records',
      },
      { code: 'example_failed', message: "example 1: now 'never' is not an ISO instant" },
    ])
    expect(checked.examples).toHaveLength(2)
  })
})

describe('validateStructure', () => {
  it('checks structure and params without a target model', () => {
    const version = versionOf({
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'y', extra: true },
        { id: 'm', op: 'map', in: 's', fields: [] },
        { id: 'out', op: 'sink', in: 'm', target: 't', key: ['a'] },
        { id: 'z', op: 'nope' },
      ],
    })
    expect(validateStructure(version).map((i) => [i.code, i.node, i.message])).toEqual([
      ['unknown_op', 'z', "unknown node op 'nope'"],
      ['invalid_params', 's', 'Unrecognized key: "extra"'],
      ['invalid_params', 'm', 'fields: Too small: expected array to have >=1 items'],
    ])
  })

  it('is empty for a well-formed draft', () => {
    expect(validateStructure(v([]))).toEqual([])
  })
})
