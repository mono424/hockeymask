/** Access ops, the pipeline entry points: `extract`, `const`, `coalesce`. */

import { z } from 'zod'
import { fieldType } from '../context'
import { ok, type Result } from '../result'
import { isNullable, type MType, stripNull, t, typeOfJson, unifyAll } from '../types'
import type { Val } from '../values'
import { defineOp, json, never, params } from './def'

/** Reads one field of the current record, or a tuple of fields. A missing field is null. */
export const extract = defineOp({
  name: 'extract',
  params: params({ path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }),
  nulls: 'consume',
  input: 'none',
  fallible: never,
  signature: (_input, p, env): Result<MType, string> => {
    if (typeof p.path === 'string') return fieldType(env.record, p.path)
    const types: MType[] = []
    for (const path of p.path) {
      const type = fieldType(env.record, path)
      if (!type.ok) return type
      types.push(type.value)
    }
    return ok(t.tuple(types))
  },
  run: (p) => {
    if (typeof p.path === 'string') {
      const path = p.path
      return (_input, ctx) => ok(ctx.record[path] ?? null)
    }
    const paths = p.path
    return (_input, ctx) => ok(paths.map((x) => ctx.record[x] ?? null))
  },
})

/** A literal value. */
export const constant = defineOp({
  name: 'const',
  params: params({ value: json }),
  nulls: 'consume',
  input: 'none',
  fallible: never,
  signature: (_input, p) => ok(typeOfJson(p.value)),
  run: (p) => {
    const value = p.value as Val
    return () => ok(value)
  },
})

/** The first non-null of several fields. Nullable only if every field is. */
export const coalesce = defineOp({
  name: 'coalesce',
  params: params({ paths: z.array(z.string().min(1)).min(2) }),
  nulls: 'consume',
  input: 'none',
  fallible: never,
  signature: (_input, p, env): Result<MType, string> => {
    const types: MType[] = []
    for (const path of p.paths) {
      const type = fieldType(env.record, path)
      if (!type.ok) return type
      types.push(type.value)
    }
    const common = unifyAll(types)
    if (!common.ok) return common
    return ok(types.every(isNullable) ? common.value : stripNull(common.value))
  },
  run: (p) => {
    const paths = p.paths
    return (_input, ctx) => {
      for (const path of paths) {
        const v = ctx.record[path] ?? null
        if (v !== null) return ok(v)
      }
      return ok(null)
    }
  },
})
