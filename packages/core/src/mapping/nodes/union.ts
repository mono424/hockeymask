/**
 * `union`: set union of inputs with the same fields. Field types must agree up to
 * nullability (a field nullable in any input is nullable in the output); project with a
 * `map` first otherwise. Duplicates collapse.
 */

import { z } from 'zod'
import { expectOk, ok } from '../result'
import { type MType, show, t, unify } from '../types'
import { keyOf, type Rec } from '../values'
import { defineNode, fail, nodeId, type NodeIssue, type Origin } from './def'

const params = z.strictObject({ inputs: z.array(nodeId).min(2) })

export const unionNode = defineNode({
  op: 'union',
  label: 'Union',
  category: 'transform',
  description: 'All records of several inputs with the same fields; duplicates collapse.',
  slots: [{ id: 'inputs', label: 'Inputs', path: ['inputs'], multiple: true }],
  output: true,
  defaults: () => ({ inputs: [] }),
  params,
  compile: (p, env) => {
    const outputs = p.inputs.map((id) => env.input(id))
    const first = outputs[0] as (typeof outputs)[number]
    const names = Object.keys(first.type.fields).sort()
    const issues: NodeIssue[] = []
    const fields: Record<string, MType> = {}
    const origins: Record<string, Origin> = {}
    for (const [i, out] of outputs.entries()) {
      const other = Object.keys(out.type.fields).sort()
      if (other.join('\u0000') !== names.join('\u0000')) {
        return fail(
          `${p.inputs[i]} has fields ${other.join(', ')}; ${p.inputs[0]} has ${names.join(', ')}`,
        )
      }
    }
    for (const name of names) {
      let type: MType = t.never
      let present: MType = t.never
      let omittable = false
      for (const [i, out] of outputs.entries()) {
        const field = out.type.fields[name] as MType
        const u = unify(type, field)
        if (!u.ok) {
          issues.push({
            message: `${name}: ${p.inputs[i]} gives ${show(field)}, earlier inputs ${show(type)}`,
          })
          break
        }
        type = u.value
        const origin = out.origins[name] as Origin
        omittable ||= origin.omittable
        present = expectOk(unify(present, origin.present ?? field))
      }
      fields[name] = type
      origins[name] = { node: env.id, field: name, omittable, ...(omittable ? { present } : {}) }
    }
    if (issues.length) return { ok: false, error: issues }
    return ok({
      output: { type: t.record(fields), origins },
      run: (inputs) => {
        const seen = new Set<string>()
        const rows: Rec[] = []
        for (const id of p.inputs) {
          for (const row of inputs(id)) {
            const k = keyOf(row, names)
            if (seen.has(k)) continue
            seen.add(k)
            rows.push(row)
          }
        }
        return ok({ rows })
      },
    })
  },
})
