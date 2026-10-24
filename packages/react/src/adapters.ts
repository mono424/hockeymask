/**
 * Pure translation between a hockeymask MappingVersion (the document) and React Flow's
 * nodes and edges (the view). The document is the source of truth; React Flow only ever
 * sees a projection of it. Edges are not stored: they are the nodes' input references.
 */

import {
  type CatalogEntry,
  type CompileIssue,
  edgesOf,
  type MappingVersion,
  type NodeJson,
  nodeCatalog,
  type Position,
} from '@hockeymask/core'
import type { Edge, Node } from '@xyflow/react'

export const NODE_TYPE = 'hockeymask'

/** Id of every node's single output handle. Input handles are named after the node's slots. */
export const OUTPUT_HANDLE = 'out'

/** dataTransfer type of a node template dragged onto a GraphBuilder. */
export const NODE_TYPE_MIME = 'application/x-hockeymask-node'

/** What a drop creates: a node of `op`, with `params` over the op's defaults. */
export interface NodeTemplate {
  op: string
  params?: Record<string, unknown>
  label?: string
}

/** Start a drag that a GraphBuilder turns into a node (palette items, host lists, ...). */
export function writeNodeTemplate(dataTransfer: DataTransfer, template: NodeTemplate): void {
  dataTransfer.setData(NODE_TYPE_MIME, JSON.stringify(template))
  dataTransfer.effectAllowed = 'copy'
}

export function readNodeTemplate(dataTransfer: DataTransfer): NodeTemplate | null {
  const raw = dataTransfer.getData(NODE_TYPE_MIME)
  if (!raw) return null
  try {
    const template = JSON.parse(raw) as Partial<NodeTemplate> | null
    return typeof template?.op === 'string' ? (template as NodeTemplate) : null
  } catch {
    return null
  }
}

/** The catalog entry of a node op, if core knows it. */
export function catalogEntry(op: string): CatalogEntry | undefined {
  return nodeCatalog.find((entry) => entry.op === op)
}

/** A node's display name: its own label, else the entity a sink writes, else its op's label. */
export function nodeTitle(node: NodeJson): string {
  if (node.label !== undefined) return node.label
  if (node.op === 'sink' && typeof node.target === 'string' && node.target) return node.target
  return catalogEntry(node.op)?.label ?? node.op
}

export interface FlowNodeData extends Record<string, unknown> {
  node: NodeJson
  entry: CatalogEntry | undefined
  issues: CompileIssue[]
}

export type FlowNode = Node<FlowNodeData, typeof NODE_TYPE>

export function toFlowNodes(
  version: MappingVersion,
  options: { issues?: readonly CompileIssue[]; selectedNodeId?: string | null } = {},
): FlowNode[] {
  return version.nodes.map((node, index) => ({
    id: node.id,
    type: NODE_TYPE,
    position: positionOf(version, node.id, index),
    selected: node.id === options.selectedNodeId,
    data: {
      node,
      entry: catalogEntry(node.op),
      issues: (options.issues ?? []).filter((issue) => issue.node === node.id),
    },
  }))
}

/** Ids of every edge on a path into `id`, back to the nodes with no inputs. */
function upstreamOf(edges: readonly { id: string; source: string; target: string }[], id: string) {
  const reached = new Set([id])
  const marked = new Set<string>()
  const queue = [id]
  for (let target = queue.pop(); target !== undefined; target = queue.pop()) {
    for (const edge of edges) {
      if (edge.target !== target) continue
      marked.add(edge.id)
      if (!reached.has(edge.source)) {
        reached.add(edge.source)
        queue.push(edge.source)
      }
    }
  }
  return marked
}

/**
 * Edges feeding the selected node, all the way back to its inputs, are marked
 * `hm-edge--upstream` and drawn in the selected node's category.
 */
export function toFlowEdges(
  version: MappingVersion,
  options: { selectedEdgeIds?: ReadonlySet<string>; selectedNodeId?: string | null } = {},
): Edge[] {
  const edges = edgesOf(version)
  const focus = version.nodes.find((node) => node.id === options.selectedNodeId)
  const upstream = focus ? upstreamOf(edges, focus.id) : new Set<string>()
  const className =
    focus && `hm-edge--upstream hm-edge--${catalogEntry(focus.op)?.category ?? 'unknown'}`
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: OUTPUT_HANDLE,
    target: edge.target,
    targetHandle: edge.slot,
    type: 'smoothstep',
    selected: options.selectedEdgeIds?.has(edge.id) ?? false,
    ...(upstream.has(edge.id) ? { className, zIndex: 1 } : {}),
  }))
}

/** A node's position: from the version's layout, or a column by document order. */
export function positionOf(version: MappingVersion, id: string, index: number): Position {
  return version.layout?.[id] ?? fallbackPosition(index)
}

/** Where a newly added node goes: right of everything already on the canvas. */
export function nextPosition(version: MappingVersion): Position {
  if (version.nodes.length === 0) return { x: 0, y: 0 }
  const placed = version.nodes.map((n, i) => positionOf(version, n.id, i))
  const right = Math.max(...placed.map((p) => p.x))
  const top = Math.min(...placed.map((p) => p.y))
  return { x: right + COLUMN, y: top }
}

/**
 * A free spot for a new node of `op`, keeping the left-to-right flow: sources in the left
 * column, targets in the right one, transforms and checks in between, each below its column.
 */
export function freePosition(version: MappingVersion, op: string): Position {
  const category = catalogEntry(op)?.category ?? 'transform'
  const placed = version.nodes.map((n, i) => positionOf(version, n.id, i))
  const xs = placed.map((p) => p.x)
  const left = xs.length > 0 ? Math.min(...xs) : 0
  const right = xs.length > 0 ? Math.max(...xs, left + 2 * COLUMN) : 2 * COLUMN
  const x = category === 'source' ? left : category === 'target' ? right : (left + right) / 2
  const column = placed.filter((p) => Math.abs(p.x - x) < COLUMN / 2)
  const top = placed.length > 0 ? Math.min(...placed.map((p) => p.y)) : 0
  const y = column.length > 0 ? Math.max(...column.map((p) => p.y)) + ROW : top
  return { x, y }
}

const COLUMN = 280
const ROW = 130

function fallbackPosition(index: number): Position {
  return { x: index * COLUMN, y: 0 }
}
