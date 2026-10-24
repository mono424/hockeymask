/** The record op registry: every op a `map` field pipeline may use, by name. */

import { coalesce, constant, extract } from './access'
import { assertType, toBool, toDate, toNumber, toString } from './convert'
import { formatDateOp, shiftDate, toUtc, truncateDate } from './date'
import type { OpDef } from './def'
import { fn } from './fn'
import { contains, each, filterList, first, index, last, len, max, min, sum, unique } from './list'
import { lookup } from './lookup'
import { blankToNull, defaultOp, omitIfNull, requireOp } from './nulls'
import { abs, add, clamp, convertUnit, divide, multiply, round, subtract } from './numeric'
import {
  concat,
  join,
  lower,
  pad,
  regexExtract,
  replace,
  slug,
  split,
  trim,
  truncate,
  upper,
} from './string'
import { when } from './when'

export type { OpDef, Step, StepResult } from './def'
export { defineOp } from './def'

const all = [
  extract,
  constant,
  coalesce,
  blankToNull,
  defaultOp,
  requireOp,
  omitIfNull,
  toNumber,
  toString,
  toBool,
  toDate,
  assertType,
  add,
  subtract,
  multiply,
  divide,
  round,
  abs,
  clamp,
  convertUnit,
  trim,
  lower,
  upper,
  truncate,
  pad,
  replace,
  regexExtract,
  split,
  join,
  concat,
  slug,
  formatDateOp,
  shiftDate,
  truncateDate,
  toUtc,
  when,
  each,
  filterList,
  index,
  first,
  last,
  len,
  unique,
  sum,
  min,
  max,
  contains,
  lookup,
  fn,
]

export const opRegistry: Readonly<Record<string, OpDef<unknown>>> = Object.fromEntries(
  all.map((op) => [op.name, op as unknown as OpDef<unknown>]),
)
