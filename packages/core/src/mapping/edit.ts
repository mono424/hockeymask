/**
 * Pure, immutable edits of a version's graph, for the editor. Every edit returns a new
 * version. `canConnect` is the single rule book for edges, so live feedback while dragging
 * and validation on save agree. Edges are derived from input references (`edgesOf`).
 */

import type { MappingVersion, NodeJson, Position } from './document'
import { downstream, nodeRefs } from './graph'
import { nodeCatalog, nodeRegistry, type Slot } from './nodes'

export { nodeCatalog }

export interface Edge {
  /** Stable id: `source->target:slot[index]`. */
  readonly id: string
  readonly source: string
  readonly target: string
  /** Slot id on the target node, used as the React Flow target handle. */
  readonly slot: string
  readonly index?: number
}

/** A prospective edge. */
export interface Connection {
  readonly source: string
  readonly target: string
  readonly slot: string
}

export type ConnectResult = { ok: true } | { ok: false; reason: string }

let counter = 0

/** A short unique id; `crypto.randomUUID` where available, a counter otherwise. */
export function createId(prefix: string): string {
  counter += 1
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8)
  return `${prefix}_${random ?? counter.toString(36)}`
}

export function getNode(version: MappingVersion, id: string): NodeJson | undefined {
  return version.nodes.find((n) => n.id === id)
}

const defOf = (op: string) => (Object.hasOwn(nodeRegistry, op) ? nodeRegistry[op] : undefined)

export function edgesOf(version: MappingVersion): Edge[] {
  return version.nodes.flatMap((node) =>
    nodeRefs(node).map((r) => ({
      id: `${r.source}->${node.id}:${r.slot}${r.index === undefined ? '' : `[${r.index}]`}`,
      source: r.source,
      target: node.id,
      slot: r.slot,
      ...(r.index === undefined ? {} : { index: r.index }),
    })),
  )
}

/** Add a node of a known op with its default params. */
export function addNode(
  version: MappingVersion,
  op: string,
  init: { id?: string; label?: string; params?: Record<string, unknown>; position?: Position } = {},
): { version: MappingVersion; node: NodeJson } {
  const def = defOf(op)
  if (!def) throw new Error(`Unknown node op '${op}'`)
  const id = init.id ?? createId(op)
  if (getNode(version, id)) throw new Error(`Node id '${id}' already exists`)
  const node: NodeJson = {
    ...def.defaults(),
    ...init.params,
    id,
    op,
    ...(init.label === undefined ? {} : { label: init.label }),
  }
  return {
    version: {
      ...version,
      nodes: [...version.nodes, node],
      ...(init.position ? { layout: { ...version.layout, [id]: init.position } } : {}),
    },
    node,
  }
}

function setPath(node: NodeJson, path: readonly string[], value: unknown): NodeJson {
  const [head, ...rest] = path as [string, ...string[]]
  if (rest.length === 0) {
    const copy: Record<string, unknown> = { ...node }
    if (value === undefined) delete copy[head]
    else copy[head] = value
    return copy as NodeJson
  }
  const child = (node as Record<string, unknown>)[head]
  const inner = typeof child === 'object' && child !== null ? child : {}
  return { ...node, [head]: setPath(inner as NodeJson, rest, value) } as NodeJson
}

function getPath(node: NodeJson, path: readonly string[]): unknown {
  let value: unknown = node
  for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key]
  return value
}

function slotOf(node: NodeJson, slot: string): Slot | undefined {
  return defOf(node.op)?.slots.find((s) => s.id === slot)
}

/** Remove a node, every reference to it, and its layout entry. */
export function removeNode(version: MappingVersion, id: string): MappingVersion {
  const nodes = version.nodes
    .filter((n) => n.id !== id)
    .map((n) => {
      let next = n
      for (const ref of nodeRefs(n)
        .filter((r) => r.source === id)
        .reverse()) {
        next = unlink(next, ref.slot, id)
      }
      return next
    })
  const layout = version.layout ? { ...version.layout } : undefined
  if (layout) delete layout[id]
  const expect = { ...version.expect }
  delete expect[id]
  return { ...version, nodes, expect, ...(layout ? { layout } : {}) }
}

/** Drop `node`'s reference to `source` in `slotId`; anything else is left as it is. */
function unlink(node: NodeJson, slotId: string, source: string): NodeJson {
  const slot = slotOf(node, slotId)
  if (!slot) return node
  const value = getPath(node, slot.path)
  if (Array.isArray(value))
    return setPath(
      node,
      slot.path,
      value.filter((v) => v !== source),
    )
  return value === source ? setPath(node, slot.path, undefined) : node
}

/**
 * Replace a node's label and/or params; `id` and `op` cannot change. A `label` key set to
 * undefined clears the label.
 */
export function updateNode(
  version: MappingVersion,
  id: string,
  patch: { label?: string | undefined; params?: Record<string, unknown> },
): MappingVersion {
  return {
    ...version,
    nodes: version.nodes.map((n) => {
      if (n.id !== id) return n
      const label = 'label' in patch ? patch.label : n.label
      const params = patch.params ?? (({ id: _i, op: _o, label: _l, ...rest }) => rest)(n)
      return { ...params, id: n.id, op: n.op, ...(label === undefined ? {} : { label }) }
    }),
  }
}

export function moveNode(version: MappingVersion, id: string, position: Position): MappingVersion {
  return { ...version, layout: { ...version.layout, [id]: position } }
}

/** Every rule a new edge must satisfy, checked against the current version. */
export function canConnect(version: MappingVersion, connection: Connection): ConnectResult {
  const source = getNode(version, connection.source)
  const target = getNode(version, connection.target)
  if (!source || !target) return { ok: false, reason: 'Both ends must be nodes in the graph.' }
  if (source.id === target.id) return { ok: false, reason: 'A node cannot feed itself.' }
  const from = defOf(source.op)
  if (!from || !defOf(target.op)) return { ok: false, reason: 'Unknown node op.' }
  if (!from.output) return { ok: false, reason: `${from.label} has no output.` }
  const slot = slotOf(target, connection.slot)
  if (!slot) return { ok: false, reason: `${target.op} has no input '${connection.slot}'.` }
  const refs = nodeRefs(target).filter((r) => r.slot === slot.id)
  if (refs.some((r) => r.source === source.id))
    return { ok: false, reason: 'These nodes are already connected.' }
  if (refs.length > 0 && !slot.multiple)
    return { ok: false, reason: `Input '${slot.label}' already has a connection.` }
  if (downstream(version.nodes, target.id).has(source.id)) {
    return { ok: false, reason: 'This connection would create a cycle; mappings must be acyclic.' }
  }
  return { ok: true }
}

/** Add an edge by setting the target's input reference, or throw with `canConnect`'s reason. */
export function connect(version: MappingVersion, connection: Connection): MappingVersion {
  const verdict = canConnect(version, connection)
  if (!verdict.ok) throw new Error(verdict.reason)
  return {
    ...version,
    nodes: version.nodes.map((n) => {
      if (n.id !== connection.target) return n
      const slot = slotOf(n, connection.slot) as Slot
      const current = getPath(n, slot.path)
      const value = slot.multiple
        ? [...(Array.isArray(current) ? current : []), connection.source]
        : connection.source
      return setPath(n, slot.path, value)
    }),
  }
}

/** Remove an edge by clearing the target's reference to its source. */
export function disconnect(
  version: MappingVersion,
  edge: Pick<Edge, 'source' | 'target' | 'slot'>,
): MappingVersion {
  return {
    ...version,
    nodes: version.nodes.map((n) => (n.id === edge.target ? unlink(n, edge.slot, edge.source) : n)),
  }
}
