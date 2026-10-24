/** `distinct`: deduplicates on `keys` and projects to them. */

import { z } from 'zod'
import { ok } from '../result'
import { type MType, t } from '../types'
import { keyOf, type Rec, type Val } from '../values'
import { defineNode, fail, nodeId, type Origin } from './def'

const params = z.strictObject({ in: nodeId, keys: z.array(z.string().min(1)).min(1) })

export const distinctNode = defineNode({
  op: 'distinct',
  label: 'Distinct',
  category: 'transform',
  description: 'One record per distinct combination of the key fields.',
  slots: [{ id: 'in', label: 'In', path: ['in'] }],
  output: true,
  defaults: () => ({ in: '', keys: [] }),
  params,
  compile: (p, env) => {
    const input = env.input(p.in)
    const unknown = p.keys.filter((k) => !Object.hasOwn(input.type.fields, k))
    if (unknown.length) return fail(`unknown keys: ${unknown.join(', ')}`)
    const fields: Record<string, MType> = {}
    const origins: Record<string, Origin> = {}
    for (const k of p.keys) {
      fields[k] = input.type.fields[k] as MType
      origins[k] = input.origins[k] as Origin
    }
    return ok({
      output: { type: t.record(fields), origins },
      run: (inputs) => {
        const seen = new Set<string>()
        const rows: Rec[] = []
        for (const row of inputs(p.in)) {
          const k = keyOf(row, p.keys)
          if (seen.has(k)) continue
          seen.add(k)
          rows.push(Object.fromEntries(p.keys.map((f) => [f, (row[f] ?? null) as Val])))
        }
        return ok({ rows })
      },
    })
  },
})
