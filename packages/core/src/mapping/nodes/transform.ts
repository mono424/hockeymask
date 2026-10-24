/**
 * `transform`: the collection-scope escape hatch. Calls reviewed, version-pinned code the host
 * registers in `GraphEnv.transforms`; its declared output `schema` (JSON Schema of one record)
 * keeps the rest of the graph type-checked, and its rows are checked against it at runtime.
 */

import { z } from 'zod'
import type { TransformDef } from '../context'
import { JsonSchema } from '../document'
import { sourceRecordType } from '../jsonschema'
import { err, ok } from '../result'
import { defineNode, fail, nodeId, ownOrigins } from './def'
import { loadRows } from './source'

const params = z.strictObject({
  ref: z.string().min(1),
  inputs: z.array(nodeId).min(1),
  schema: JsonSchema,
})

export const transformNode = defineNode({
  op: 'transform',
  label: 'Transform (code)',
  category: 'transform',
  description: 'Reviewed, version-pinned code with a declared output schema.',
  slots: [{ id: 'inputs', label: 'Inputs', path: ['inputs'], multiple: true }],
  output: true,
  defaults: () => ({ ref: '', inputs: [], schema: { type: 'object', properties: {} } }),
  params,
  compile: (p, env) => {
    for (const id of p.inputs) env.input(id)
    const transforms = env.graph.transforms ?? {}
    if (!Object.hasOwn(transforms, p.ref)) return fail(`unknown transform '${p.ref}'`)
    const type = sourceRecordType(p.schema)
    if (!type.ok) return fail(`schema: ${type.error}`)
    const record = type.value
    const transform = transforms[p.ref] as TransformDef
    return ok({
      output: { type: record, origins: ownOrigins(env.id, record) },
      run: (inputs, ctx) => {
        const result = transform.run(p.inputs.map(inputs), ctx)
        if (!result.ok) return err({ code: 'transform_failed', message: result.error })
        const loaded = loadRows(env.id, result.value, record)
        return loaded.ok ? ok({ rows: loaded.value }) : loaded
      },
    })
  },
})
