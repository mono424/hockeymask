/** Null and blank handling: `blank_to_null`, `default`, `require`, `omit_if_null`. */

import { z } from 'zod'
import { err, ok, stepError } from '../result'
import { assignable, show, stripNull, t, typeOfJson } from '../types'
import { OMIT, type Val } from '../values'
import { always, defineOp, expectKind, json, never, params } from './def'

/** An empty or whitespace-only string becomes null. */
export const blankToNull = defineOp({
  name: 'blank_to_null',
  params: params({}),
  nulls: 'propagate',
  fallible: never,
  signature: (input) => {
    const s = expectKind(input, ['string'], 'blank_to_null')
    return s.ok ? ok(t.nullable(t.string)) : s
  },
  run: () => (input) => ok((input as string).trim() === '' ? null : input),
})

/** Replaces null with a literal of the input's type. */
export const defaultOp = defineOp({
  name: 'default',
  params: params({ value: json }),
  nulls: 'consume',
  fallible: never,
  signature: (input, p) => {
    if (p.value === null) return err('default needs a non-null value')
    const base = stripNull(input)
    const literal = typeOfJson(p.value)
    if (base.kind === 'unknown') return ok(literal)
    return assignable(literal, base)
      ? ok(base)
      : err(`default value is ${show(literal)}, input is ${show(input)}`)
  },
  run: (p) => {
    const value = p.value as Val
    return (input) => ok(input ?? value)
  },
})

/** Null triggers the node's `on_error` policy. */
export const requireOp = defineOp({
  name: 'require',
  params: params({ message: z.string().optional() }),
  nulls: 'consume',
  fallible: always,
  signature: (input) => ok(stripNull(input)),
  run: (p) => {
    const message = p.message ?? 'required value is null'
    return (input) => (input === null ? stepError('required_null', message) : ok(input))
  },
})

/**
 * Terminal. A null leaves the field out of the record (and so out of the write) instead of
 * setting it to null. Readers downstream see the field as nullable.
 */
export const omitIfNull = defineOp({
  name: 'omit_if_null',
  params: params({}),
  nulls: 'consume',
  terminal: true,
  fallible: never,
  signature: (input) => ok(t.nullable(stripNull(input))),
  run: () => (input) => ok(input === null ? OMIT : input),
})
