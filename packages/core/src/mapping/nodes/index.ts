/** The collection node registry, and the catalog the editor builds its palette from. */

import { aggregateNode } from './aggregate'
import { assertNode } from './assert'
import type { NodeCategory, NodeDef, Slot } from './def'
import { distinctNode } from './distinct'
import { filterNode } from './filter'
import { joinNode } from './join'
import { mapNode } from './map'
import { metricsNode } from './metrics'
import { sinkNode } from './sink'
import { sourceNode } from './source'
import { transformNode } from './transform'
import { unionNode } from './union'

export type * from './def'
export { defineNode } from './def'
export { refType, resolveTarget } from './sink'
export { findCycle } from './assert'

const all = [
  sourceNode,
  mapNode,
  filterNode,
  joinNode,
  aggregateNode,
  distinctNode,
  unionNode,
  sinkNode,
  metricsNode,
  assertNode,
  transformNode,
]

export const nodeRegistry: Readonly<Record<string, NodeDef<unknown>>> = Object.fromEntries(
  all.map((def) => [def.op, def as unknown as NodeDef<unknown>]),
)

/** What the editor needs to place a node and draw its handles. */
export interface CatalogEntry {
  readonly op: string
  readonly label: string
  readonly category: NodeCategory
  readonly description: string
  readonly slots: readonly Slot[]
  readonly output: boolean
  readonly defaults: () => Record<string, unknown>
}

export const nodeCatalog: readonly CatalogEntry[] = all.map(
  ({ op, label, category, description, slots, output, defaults }) => ({
    op,
    label,
    category,
    description,
    slots,
    output,
    defaults,
  }),
)
