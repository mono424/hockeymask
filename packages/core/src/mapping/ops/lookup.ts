/** `lookup`: a static value map stored with the version, for enum and code translation. */

import { z } from 'zod'
import { err, expectOk, ok, stepError } from '../result'
import { comparable, show, t, typeOfJson, unify, unifyAll } from '../types'
import type { Json, Val } from '../values'
import { defineOp, params } from './def'

const SCALAR = new Set(['string', 'number', 'boolean'])

/**
 * Translate a scalar through `tables[table]` (keys are the value's string form). `on_miss`:
 * `null` (default) yields null, `pass` forwards the input, `error` raises `lookup_miss`.
 */
export const lookup = defineOp({
  name: 'lookup',
  params: params({
    table: z.string().min(1),
    on_miss: z.enum(['null', 'pass', 'error']).optional(),
  }),
  nulls: 'propagate',
  fallible: (p) => p.on_miss === 'error',
  signature: (input, p, env) => {
    if (!SCALAR.has(input.kind))
      return err(`lookup expects a string, number or boolean, got ${show(input)}`)
    if (!Object.hasOwn(env.tables, p.table)) return err(`unknown lookup table '${p.table}'`)
    const values = Object.values(env.tables[p.table] as Record<string, Json>)
    const value = unifyAll(values.map(typeOfJson))
    if (!value.ok) return err(`lookup table '${p.table}' mixes value types: ${value.error}`)
    switch (p.on_miss ?? 'null') {
      case 'null':
        return ok(t.nullable(value.value))
      case 'error':
        return ok(value.value)
      default: {
        if (!comparable(input, value.value)) {
          return err(
            `on_miss "pass" forwards ${show(input)}, but the table yields ${show(value.value)}`,
          )
        }
        return ok(expectOk(unify(input, value.value)))
      }
    }
  },
  run: (p, env) => {
    const table = env.tables[p.table] as Readonly<Record<string, Json>>
    const miss = p.on_miss ?? 'null'
    return (input) => {
      const key = String(input as string | number | boolean)
      if (Object.hasOwn(table, key)) return ok(table[key] as Val)
      if (miss === 'error') return stepError('lookup_miss', `'${key}' is not in table '${p.table}'`)
      return ok(miss === 'pass' ? input : null)
    }
  },
})
