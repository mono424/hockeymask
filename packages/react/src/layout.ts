import { edgesOf, type MappingVersion } from '@hockeymask/core'
import { Graph, layout } from '@dagrejs/dagre'
import { catalogEntry } from './adapters'

export const NODE_WIDTH = 216
const CHROME_HEIGHT = 78 // tag offset, header, summary line
const PORT_HEIGHT = 22
const START = '\u0000start'
const END = '\u0000end'

/** Rough rendered height, enough for dagre to keep rows apart. */
export function nodeHeight(op: string): number {
  // only nodes with several inputs get labelled rows (a join's left and right)
  const inputs = catalogEntry(op)?.slots.length ?? 0
  return CHROME_HEIGHT + (inputs > 1 ? inputs : 0) * PORT_HEIGHT
}

/**
 * Left-to-right layered layout; returns a new document with `layout` filled in. Sources are
 * pulled to the left and targets to the right even before they are connected, via two
 * invisible anchor nodes.
 */
export function layoutGraph(version: MappingVersion): MappingVersion {
  const g = new Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  g.setNode(START, { width: 0, height: 0 })
  g.setNode(END, { width: 0, height: 0 })
  const ids = new Set(version.nodes.map((n) => n.id))
  const edges = edgesOf(version).filter((e) => ids.has(e.source))
  for (const node of version.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: nodeHeight(node.op) })
  }
  for (const edge of edges) g.setEdge(edge.source, edge.target)
  for (const node of version.nodes) {
    const category = catalogEntry(node.op)?.category
    const fed = edges.some((e) => e.target === node.id)
    const feeds = edges.some((e) => e.source === node.id)
    if (category === 'source' || !fed) {
      g.setEdge(START, node.id, {
        weight: category === 'source' ? 10 : 1,
        minlen: category === 'target' ? 2 : 1,
      })
    }
    if (category === 'target' || !feeds) {
      g.setEdge(node.id, END, { weight: category === 'target' ? 10 : 1 })
    }
  }
  layout(g)
  return {
    ...version,
    layout: Object.fromEntries(
      version.nodes.map((node) => {
        const placed = g.node(node.id)
        const height = nodeHeight(node.op)
        // dagre returns centres; React Flow positions are top-left corners
        return [node.id, { x: placed.x - NODE_WIDTH / 2, y: placed.y - height / 2 }]
      }),
    ),
  }
}
