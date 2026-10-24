import { expect, it } from 'vite-plus/test'
import { planOf, runOf, schemaOf, targetsOf, versionOf } from './helpers'

it('graph helpers compile and run a source -> map -> sink graph', () => {
  const version = versionOf({
    expectedSchema: { s: schemaOf({ a: 'string', n: 'number?' }) },
    nodes: [
      { id: 's', op: 'source', system: 'x', entity: 'y' },
      {
        id: 'm',
        op: 'map',
        in: 's',
        fields: [{ key: 'a', pipeline: [{ op: 'extract', path: 'a' }] }],
      },
      { id: 'out', op: 'sink', in: 'm', target: 't', key: ['a'] },
    ],
  })
  const plan = planOf(version, { targets: targetsOf({ t: { a: 'string' } }) })
  const run = runOf(plan, { s: [{ a: 'x', n: 1 }] })
  expect(run.outputs?.out).toEqual([{ a: 'x' }])
})
