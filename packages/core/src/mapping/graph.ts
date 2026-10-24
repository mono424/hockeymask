/**
 * Edges are implied by input references (`in`, `left`, `right`, `inputs`, and an assert's
 * `per.in` / `remove.in`); each node definition's `slots` name them. Everything that walks the
 * graph (ordering, dead nodes, lineage, freeing edges, the editor's edges) reads them here.
 */

import type { NodeJson } from './document'
import { nodeRegistry } from './nodes'

export interface Ref {
  /** Slot id on the consuming node. */
  readonly slot: string
  /** Id of the referenced (upstream) node. */
  readonly source: string
  /** Position within a `multiple` slot. */
  readonly index?: number
}

function at(node: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let value: unknown = node
  for (const key of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** The input references of a node, slot by slot. Unknown ops have none. */
export function nodeRefs(node: NodeJson): Ref[] {
  const def = Object.hasOwn(nodeRegistry, node.op) ? nodeRegistry[node.op] : undefined
  if (!def) return []
  const refs: Ref[] = []
  for (const slot of def.slots) {
    const value = at(node, slot.path)
    if (slot.multiple && Array.isArray(value)) {
      for (const [index, source] of value.entries()) {
        if (typeof source === 'string' && source !== '') refs.push({ slot: slot.id, source, index })
      }
    } else if (typeof value === 'string' && value !== '') {
      refs.push({ slot: slot.id, source: value })
    }
  }
  return refs
}

/** Distinct upstream ids of a node, in slot order. */
export function inputIds(node: NodeJson): string[] {
  return [...new Set(nodeRefs(node).map((r) => r.source))]
}

/** Downstream neighbours of every node (only references to existing nodes). */
export function consumers(nodes: readonly NodeJson[]): Map<string, string[]> {
  const ids = new Set(nodes.map((n) => n.id))
  const next = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  for (const node of nodes) {
    for (const source of inputIds(node)) {
      if (ids.has(source)) (next.get(source) as string[]).push(node.id)
    }
  }
  return next
}

function reach(start: string, next: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>()
  const stack = [...(next.get(start) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(next.get(id) as readonly string[]))
  }
  return seen
}

/** Every node fed by `id`, directly or not (not including `id`). */
export function downstream(nodes: readonly NodeJson[], id: string): Set<string> {
  return reach(id, consumers(nodes))
}

/** Every node feeding `id`, directly or not (not including `id`). */
export function upstream(nodes: readonly NodeJson[], id: string): Set<string> {
  const ids = new Set(nodes.map((n) => n.id))
  const prev = new Map(nodes.map((n) => [n.id, inputIds(n).filter((s) => ids.has(s))]))
  return reach(id, prev)
}

/** One cycle as node ids (first repeated at the end), or null if acyclic. */
export function findGraphCycle(nodes: readonly NodeJson[]): string[] | null {
  const next = consumers(nodes)
  const state = new Map<string, 'open' | 'done'>()
  const path: string[] = []
  const visit = (id: string): string[] | null => {
    state.set(id, 'open')
    path.push(id)
    for (const to of next.get(id) as string[]) {
      if (state.get(to) === 'open') return [...path.slice(path.indexOf(to)), to]
      if (!state.has(to)) {
        const cycle = visit(to)
        if (cycle) return cycle
      }
    }
    path.pop()
    state.set(id, 'done')
    return null
  }
  for (const node of nodes) {
    if (state.has(node.id)) continue
    const cycle = visit(node.id)
    if (cycle) return cycle
  }
  return null
}

/**
 * Node ids with every node after the nodes it reads; ties keep document order, so the result
 * is stable. Nodes on a cycle are left out (check `findGraphCycle` first).
 */
export function topologicalOrder(nodes: readonly NodeJson[]): string[] {
  const next = consumers(nodes)
  const indegree = new Map(nodes.map((n) => [n.id, 0]))
  for (const targets of next.values())
    for (const t of targets) indegree.set(t, (indegree.get(t) as number) + 1)
  const position = new Map(nodes.map((n, i) => [n.id, i]))
  const ready = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id)
  const order: string[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => (position.get(a) as number) - (position.get(b) as number))
    const id = ready.shift() as string
    order.push(id)
    for (const to of next.get(id) as string[]) {
      const remaining = (indegree.get(to) as number) - 1
      indegree.set(to, remaining)
      if (remaining === 0) ready.push(to)
    }
  }
  return order
}
