import { describe, expect, it } from 'vite-plus/test'
import { defineNode, nodeCatalog, nodeRegistry } from '../../../src/mapping/nodes'

describe('node registry and catalog', () => {
  it('registers every node op once', () => {
    expect(Object.keys(nodeRegistry)).toEqual([
      'source',
      'map',
      'filter',
      'join',
      'aggregate',
      'distinct',
      'union',
      'sink',
      'metrics',
      'assert',
      'transform',
    ])
  })

  it('catalog entries carry editor metadata and defaults that pass the op schema shape', () => {
    for (const entry of nodeCatalog) {
      const def = nodeRegistry[entry.op]
      expect(entry).toMatchObject({ label: def?.label, category: def?.category, slots: def?.slots })
      const defaults = entry.defaults()
      expect(typeof defaults).toBe('object')
      for (const slot of entry.slots) {
        if (slot.path.length === 1)
          expect((slot.path[0] as string) in defaults || slot.optional).toBe(true)
      }
    }
  })

  it('defineNode is the identity', () => {
    const def = nodeRegistry.source as never
    expect(defineNode(def)).toBe(def)
  })
})
