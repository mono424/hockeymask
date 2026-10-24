import { addNode, connect, emptyVersion, type MappingVersion } from '@hockeymask/core'
import { describe, expect, it } from 'vite-plus/test'
import {
  freePosition,
  layoutGraph,
  nextPosition,
  nodeHeight,
  nodeTitle,
  readNodeTemplate,
  toFlowEdges,
  toFlowNodes,
  writeNodeTemplate,
} from '../src'

function pipeline(): MappingVersion {
  let v = emptyVersion('test')
  v = addNode(v, 'source', { id: 'items' }).version
  v = addNode(v, 'map', { id: 'map' }).version
  v = addNode(v, 'sink', { id: 'product' }).version
  v = connect(v, { source: 'items', target: 'map', slot: 'in' })
  return connect(v, { source: 'map', target: 'product', slot: 'in' })
}

describe('toFlowNodes / toFlowEdges', () => {
  it('projects nodes with their catalog entry, selection and own issues', () => {
    const issues = [{ code: 'missing_input' as const, message: 'x', node: 'map' }]
    const nodes = toFlowNodes(pipeline(), { issues, selectedNodeId: 'map' })
    expect(nodes.map((n) => [n.id, n.selected, n.data.issues.length])).toEqual([
      ['items', false, 0],
      ['map', true, 1],
      ['product', false, 0],
    ])
    expect(nodes[0]?.data.entry?.category).toBe('source')
  })

  it('derives edges from input references: one output handle, slots as input handles', () => {
    const edges = toFlowEdges(pipeline(), { selectedEdgeIds: new Set(['map->product:in']) })
    expect(edges).toEqual([
      expect.objectContaining({
        id: 'items->map:in',
        source: 'items',
        sourceHandle: 'out',
        target: 'map',
        targetHandle: 'in',
        selected: false,
      }),
      expect.objectContaining({ id: 'map->product:in', selected: true }),
    ])
  })

  it("marks every edge back to the selected node's inputs, in that node's category", () => {
    let branched = addNode(pipeline(), 'sink', { id: 'settings' }).version
    branched = connect(branched, { source: 'map', target: 'settings', slot: 'in' })
    const marks = (selectedNodeId: string) =>
      toFlowEdges(branched, { selectedNodeId }).map((e) => [e.id, e.className, e.zIndex])
    expect(marks('product')).toEqual([
      ['items->map:in', 'hm-edge--upstream hm-edge--target', 1],
      ['map->product:in', 'hm-edge--upstream hm-edge--target', 1],
      ['map->settings:in', undefined, undefined],
    ])
    expect(marks('map')).toEqual([
      ['items->map:in', 'hm-edge--upstream hm-edge--transform', 1],
      ['map->product:in', undefined, undefined],
      ['map->settings:in', undefined, undefined],
    ])
    expect(marks('items').every(([, className]) => className === undefined)).toBe(true)
    expect(marks('gone').every(([, className]) => className === undefined)).toBe(true)
  })
})

describe('nodeTitle', () => {
  it('names a node by its label, else a sink by its target, else by its op', () => {
    expect(nodeTitle({ id: 'a', op: 'sink', target: 'product', label: 'Products' })).toBe(
      'Products',
    )
    expect(nodeTitle({ id: 'a', op: 'sink', target: 'product' })).toBe('product')
    expect(nodeTitle({ id: 'a', op: 'sink', target: '' })).toBe('Write to target')
    expect(nodeTitle({ id: 'a', op: 'map' })).toBe('Map fields')
    expect(nodeTitle({ id: 'a', op: 'nope' })).toBe('nope')
  })
})

describe('positions', () => {
  it('places new nodes to the right of the existing ones', () => {
    expect(nextPosition(emptyVersion('g'))).toEqual({ x: 0, y: 0 })
    const v = { ...pipeline(), layout: { product: { x: 600, y: 40 } } }
    expect(nextPosition(v).x).toBeGreaterThan(600)
  })

  it('places added nodes by category: sources left, targets right, transforms between', () => {
    const v = pipeline()
    const source = freePosition(v, 'source')
    const transform = freePosition(v, 'join')
    const target = freePosition(v, 'sink')
    expect(source.x).toBeLessThan(transform.x)
    expect(transform.x).toBeLessThan(target.x)
    expect(freePosition(emptyVersion('g'), 'source')).toEqual({ x: 0, y: 0 })
  })

  it('lays the DAG out left to right, into the layout', () => {
    const laid = layoutGraph(pipeline())
    const x = (id: string) => laid.layout?.[id]?.x ?? Number.NaN
    expect(x('items')).toBeLessThan(x('map'))
    expect(x('map')).toBeLessThan(x('product'))
  })

  it('puts sources left of targets before anything is connected', () => {
    let v = emptyVersion('loose')
    v = addNode(v, 'sink', { id: 'product' }).version
    v = addNode(v, 'source', { id: 'items' }).version
    const laid = layoutGraph(v)
    expect(laid.layout?.items?.x ?? 0).toBeLessThan(laid.layout?.product?.x ?? 0)
  })

  it('gives nodes with several inputs labelled rows', () => {
    expect(nodeHeight('join')).toBeGreaterThan(nodeHeight('map'))
  })
})

describe('node templates', () => {
  /** Just enough of DataTransfer for the round trip (jsdom has none). */
  function fakeTransfer() {
    const data = new Map<string, string>()
    return {
      effectAllowed: 'none',
      setData: (type: string, value: string) => void data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
    } as unknown as DataTransfer
  }

  it('round-trip a host item through a drag', () => {
    const transfer = fakeTransfer()
    const template = { op: 'source', params: { system: 'netsuite', entity: 'item' }, label: 'item' }
    writeNodeTemplate(transfer, template)
    expect(transfer.effectAllowed).toBe('copy')
    expect(readNodeTemplate(transfer)).toEqual(template)
  })

  it('ignore drags that are not node templates', () => {
    const transfer = fakeTransfer()
    expect(readNodeTemplate(transfer)).toBeNull()
    transfer.setData('application/x-hockeymask-node', '{"nope":1}')
    expect(readNodeTemplate(transfer)).toBeNull()
    transfer.setData('application/x-hockeymask-node', 'not json')
    expect(readNodeTemplate(transfer)).toBeNull()
  })
})
