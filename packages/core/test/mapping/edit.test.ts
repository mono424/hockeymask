import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { emptyVersion, type MappingVersion, type NodeJson } from '../../src/mapping/document'
import {
  addNode,
  canConnect,
  connect,
  createId,
  disconnect,
  edgesOf,
  getNode,
  moveNode,
  nodeCatalog,
  removeNode,
  updateNode,
} from '../../src/mapping/edit'

const versionWith = (nodes: NodeJson[], extra: Partial<MappingVersion> = {}): MappingVersion => ({
  ...emptyVersion('v'),
  nodes,
  ...extra,
})

/** a, b -> union u -> sink out; a -> assert check (per b, remove u). */
function graph(): MappingVersion {
  return versionWith(
    [
      { id: 'a', op: 'source', system: 's', entity: 'a' },
      { id: 'b', op: 'source', system: 's', entity: 'b' },
      { id: 'u', op: 'union', inputs: ['a', 'b'] },
      { id: 'out', op: 'sink', in: 'u', target: 't', key: ['k'] },
      {
        id: 'check',
        op: 'assert',
        check: 'acyclic',
        in: 'a',
        edge: { from: 'f', to: 't' },
        per: { in: 'b', key: 'k' },
        remove: { in: 'u', key: 'k', from: 'f', to: 't' },
      },
    ],
    { layout: { a: { x: 0, y: 0 }, u: { x: 1, y: 1 } }, expect: { u: { unique: ['k'] } } },
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('createId', () => {
  it('uses a random suffix where crypto is available', () => {
    expect(createId('map')).toMatch(/^map_[0-9a-f]{8}$/)
  })

  it('falls back to a counter without crypto', () => {
    vi.stubGlobal('crypto', undefined)
    const first = createId('map')
    expect(first).toMatch(/^map_[0-9a-z]+$/)
    expect(createId('map')).not.toBe(first)
  })
})

describe('reading', () => {
  it('finds nodes', () => {
    expect(getNode(graph(), 'u')?.op).toBe('union')
    expect(getNode(graph(), 'nope')).toBeUndefined()
  })

  it('derives edges from every slot, with positions in multiple slots', () => {
    expect(edgesOf(graph())).toEqual([
      { id: 'a->u:inputs[0]', source: 'a', target: 'u', slot: 'inputs', index: 0 },
      { id: 'b->u:inputs[1]', source: 'b', target: 'u', slot: 'inputs', index: 1 },
      { id: 'u->out:in', source: 'u', target: 'out', slot: 'in' },
      { id: 'a->check:in', source: 'a', target: 'check', slot: 'in' },
      { id: 'b->check:per', source: 'b', target: 'check', slot: 'per' },
      { id: 'u->check:remove', source: 'u', target: 'check', slot: 'remove' },
    ])
  })

  it('lists every op in the catalog', () => {
    expect(nodeCatalog.map((e) => e.op)).toContain('join')
  })
})

describe('addNode', () => {
  it('adds a node with its defaults, params, label and layout position', () => {
    const { version, node } = addNode(emptyVersion('v'), 'join', {
      id: 'j',
      label: 'Resolve',
      params: { cardinality: '1:1' },
      position: { x: 5, y: 6 },
    })
    expect(node).toEqual({
      id: 'j',
      op: 'join',
      label: 'Resolve',
      left: '',
      right: '',
      on: [],
      type: 'inner',
      cardinality: '1:1',
    })
    expect(version.nodes).toEqual([node])
    expect(version.layout).toEqual({ j: { x: 5, y: 6 } })
  })

  it('generates an id and leaves the layout alone without a position', () => {
    const { version, node } = addNode(emptyVersion('v'), 'filter')
    expect(node.id).toMatch(/^filter_/)
    expect(node.label).toBeUndefined()
    expect(version.layout).toBeUndefined()
  })

  it('rejects unknown ops and duplicate ids', () => {
    expect(() => addNode(emptyVersion('v'), 'nope')).toThrow("Unknown node op 'nope'")
    expect(() => addNode(emptyVersion('v'), 'toString')).toThrow('Unknown node op')
    expect(() => addNode(graph(), 'filter', { id: 'a' })).toThrow("Node id 'a' already exists")
  })
})

describe('removeNode', () => {
  it('drops the node, every reference to it, its layout and its expectation', () => {
    const next = removeNode(graph(), 'u')
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'b', 'out', 'check'])
    expect(getNode(next, 'out')).not.toHaveProperty('in')
    expect(getNode(next, 'check')?.remove).toEqual({ key: 'k', from: 'f', to: 't' })
    expect(next.layout).toEqual({ a: { x: 0, y: 0 } })
    expect(next.expect).toEqual({})
  })

  it('removes a node from multiple slots, keeping the other inputs', () => {
    const next = removeNode(graph(), 'a')
    expect(getNode(next, 'u')?.inputs).toEqual(['b'])
    expect(getNode(next, 'check')).not.toHaveProperty('in')
  })

  it('works without a layout', () => {
    const next = removeNode(versionWith([{ id: 'a', op: 'source' }]), 'a')
    expect(next.nodes).toEqual([])
    expect(next.layout).toBeUndefined()
  })
})

describe('updateNode / moveNode', () => {
  it('replaces params and keeps id and op', () => {
    const next = updateNode(graph(), 'a', {
      params: { system: 'x', entity: 'y', id: 'z', op: 'map' },
    })
    expect(getNode(next, 'a')).toEqual({ id: 'a', op: 'source', system: 'x', entity: 'y' })
    expect(getNode(next, 'b')).toEqual(getNode(graph(), 'b'))
  })

  it('sets, keeps and clears the label', () => {
    const labelled = updateNode(graph(), 'a', { label: 'Items' })
    expect(getNode(labelled, 'a')).toMatchObject({ label: 'Items', system: 's' })
    const kept = updateNode(labelled, 'a', { params: { system: 'x', entity: 'y' } })
    expect(getNode(kept, 'a')?.label).toBe('Items')
    const cleared = updateNode(kept, 'a', { label: undefined })
    expect(getNode(cleared, 'a')).toEqual({ id: 'a', op: 'source', system: 'x', entity: 'y' })
  })

  it('moves nodes in the layout', () => {
    expect(moveNode(graph(), 'b', { x: 3, y: 4 }).layout?.b).toEqual({ x: 3, y: 4 })
    expect(moveNode(emptyVersion('v'), 'b', { x: 3, y: 4 }).layout).toEqual({ b: { x: 3, y: 4 } })
  })
})

describe('canConnect', () => {
  const loose = () =>
    versionWith([
      ...graph().nodes,
      { id: 'm', op: 'map', in: '' },
      { id: 'j', op: 'join', left: 'm' },
      { id: 'x', op: 'mystery' },
      { id: 'metrics', op: 'metrics', in: 'u' },
    ])

  it.each([
    [{ source: 'a', target: 'nope', slot: 'in' }, 'Both ends must be nodes in the graph.'],
    [{ source: 'nope', target: 'm', slot: 'in' }, 'Both ends must be nodes in the graph.'],
    [{ source: 'm', target: 'm', slot: 'in' }, 'A node cannot feed itself.'],
    [{ source: 'x', target: 'm', slot: 'in' }, 'Unknown node op.'],
    [{ source: 'a', target: 'x', slot: 'in' }, 'Unknown node op.'],
    [{ source: 'out', target: 'm', slot: 'in' }, 'Write to target has no output.'],
    [{ source: 'metrics', target: 'm', slot: 'in' }, 'Run metrics has no output.'],
    [{ source: 'a', target: 'm', slot: 'left' }, "map has no input 'left'."],
    [{ source: 'a', target: 'u', slot: 'inputs' }, 'These nodes are already connected.'],
    [{ source: 'b', target: 'j', slot: 'left' }, "Input 'Left' already has a connection."],
    [{ source: 'u', target: 'b', slot: 'in' }, "source has no input 'in'."],
    [
      { source: 'j', target: 'm', slot: 'in' },
      'This connection would create a cycle; mappings must be acyclic.',
    ],
  ])('rejects %j: %s', (connection, reason) => {
    expect(canConnect(loose(), connection)).toEqual({ ok: false, reason })
    expect(() => connect(loose(), connection)).toThrow(reason)
  })

  it('accepts free slots, and more inputs on a multiple slot', () => {
    expect(canConnect(loose(), { source: 'a', target: 'm', slot: 'in' })).toEqual({ ok: true })
    expect(canConnect(loose(), { source: 'm', target: 'u', slot: 'inputs' })).toEqual({ ok: true })
  })
})

describe('connect / disconnect', () => {
  it('sets a single slot', () => {
    const v = versionWith([
      { id: 'a', op: 'source' },
      { id: 'm', op: 'map' },
    ])
    expect(getNode(connect(v, { source: 'a', target: 'm', slot: 'in' }), 'm')?.in).toBe('a')
  })

  it('appends to a multiple slot, creating it when missing', () => {
    const v = versionWith([
      { id: 'a', op: 'source' },
      { id: 'b', op: 'source' },
      { id: 'u', op: 'union' },
    ])
    const one = connect(v, { source: 'a', target: 'u', slot: 'inputs' })
    const two = connect(one, { source: 'b', target: 'u', slot: 'inputs' })
    expect(getNode(two, 'u')?.inputs).toEqual(['a', 'b'])
  })

  it('sets nested slots, creating the parent object when missing', () => {
    const v = versionWith([
      { id: 'a', op: 'source' },
      { id: 'b', op: 'source' },
      { id: 'check', op: 'assert', in: 'a', per: 'garbage' },
    ])
    const per = connect(v, { source: 'b', target: 'check', slot: 'per' })
    expect(getNode(per, 'check')?.per).toEqual({ in: 'b' })
    const remove = connect(per, { source: 'b', target: 'check', slot: 'remove' })
    expect(getNode(remove, 'check')?.remove).toEqual({ in: 'b' })
  })

  it('disconnects exactly the given reference', () => {
    const v = graph()
    const cut = disconnect(v, { source: 'a', target: 'u', slot: 'inputs' })
    expect(getNode(cut, 'u')?.inputs).toEqual(['b'])
    const nested = disconnect(v, { source: 'b', target: 'check', slot: 'per' })
    expect(getNode(nested, 'check')?.per).toEqual({ key: 'k' })
    expect(
      getNode(disconnect(v, { source: 'u', target: 'out', slot: 'in' }), 'out'),
    ).not.toHaveProperty('in')
  })

  it('leaves the node alone for a stale or unknown edge', () => {
    const v = graph()
    expect(disconnect(v, { source: 'b', target: 'out', slot: 'in' })).toEqual(v)
    expect(disconnect(v, { source: 'u', target: 'out', slot: 'nope' })).toEqual(v)
  })
})
