/**
 * `fn`: the record-scope escape hatch. Calls a named, reviewed, version-pinned function the
 * host registers in `GraphEnv.functions`, with a declared input and output type.
 */

import { z } from 'zod'
import type { FnDef } from '../context'
import { err, ok } from '../result'
import { assignable, show } from '../types'
import { defineOp, params } from './def'

export const fn = defineOp({
  name: 'fn',
  params: params({ ref: z.string().min(1) }),
  nulls: 'consume',
  fallible: (p, env) => env.functions[p.ref]?.fallible ?? true,
  signature: (input, p, env) => {
    const def = Object.hasOwn(env.functions, p.ref) ? env.functions[p.ref] : undefined
    if (!def) return err(`unknown function '${p.ref}'`)
    if (def.input && !assignable(input, def.input)) {
      return err(`function '${p.ref}' takes ${show(def.input)}, got ${show(input)}`)
    }
    return ok(def.output)
  },
  run: (p, env) => {
    const def = env.functions[p.ref] as FnDef
    return (input, ctx) => def.run(input, ctx)
  },
})
