import { describe, expect, it } from 'vite-plus/test'
import { checkVersion } from '../../src/mapping/check'
import { compileVersion, type Plan } from '../../src/mapping/compile'
import { runExamples } from '../../src/mapping/examples'
import { execute } from '../../src/mapping/execute'
import { expected, inventoryVersion, routes, sources, targets } from './fixtures/inventory'

const NOW = '2026-10-04T12:00:00Z'

function plan(version = inventoryVersion()): Plan {
  const compiled = compileVersion(version, { targets })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues, null, 2))
  return compiled.plan
}

/** Without the route back to Central, no product's routes loop. */
const acyclicSources = { ...sources, routes: routes.slice(0, -1) }

describe('inventory levels from stock snapshots (multi-source worked example)', () => {
  it('compiles', () => {
    expect(plan().nodes.map((n) => n.id)).toContain('no_loops')
  })

  it('produces the fixture relations, and no_loops blocks publishing', () => {
    const [result] = runExamples(plan())
    expect(result?.diffs).toEqual([])
    expect(result?.passed).toBe(false)
    expect(result?.failures).toEqual([
      'run stopped: no_loops: 1 groups have a cycle, e.g. AO-TENT-2P: Central -> North -> Downtown -> Central',
    ])
    expect(result?.run?.outputs?.status_counts).toEqual(
      expect.arrayContaining(expected.status_counts),
    )
  })

  it('reports unresolved items and locations as alerts, never failing the run', () => {
    const [result] = runExamples(plan())
    const alerts = result?.issues.filter((i) => i.node === 'status_counts')
    expect(alerts?.map((i) => [i.clause, i.action, i.samples])).toEqual([
      ['keyed', 'alert', ['unknown_item']],
      ['keyed', 'alert', ['unknown_location']],
    ])
  })

  it('on stop writes nothing but still reports metrics', () => {
    const run = execute(plan(), sources, { now: NOW })
    expect(run.status).toBe('stopped')
    expect(run.sinks.map((s) => s.status)).toEqual(['stopped', 'stopped'])
    expect(run.metrics).toEqual([
      {
        node: 'status_counts_out',
        name: 'stock.status_counts',
        rows: expect.arrayContaining(expected.status_counts),
      },
    ])
  })

  it('passes and writes once the routes have no loop', () => {
    const version = inventoryVersion({
      examples: [
        {
          sources: acyclicSources,
          expect: { route_pairs: expected.route_pairs.filter((r) => r.to_warehouse !== 'Central') },
        },
      ],
    })
    const [result] = runExamples(plan(version))
    expect(result).toMatchObject({ passed: true, failures: [], diffs: [] })
    expect(result?.run?.sinks.map((s) => s.status)).toEqual(['write', 'write'])
    expect(result?.run?.sinks[0]?.write?.rows[0]).toEqual({
      'inventory_level.product_sku': 'AO-JKT-RAIN-M',
      warehouse: 'Central',
      on_hand: 40,
      reserved: 0,
      bins: 1,
    })
  })

  it('skip_downstream holds back exactly the sinks below the node, by lineage', () => {
    const run = execute(plan(), acyclicSources, { now: NOW })
    // levels has 5 rows, outside its 1000..50000 envelope; route_out depends on it via the
    // semi join.
    expect(run.status).toBe('partial')
    expect(run.sinks).toEqual([
      { sink: 'inventory_out', status: 'held' },
      { sink: 'route_out', status: 'held' },
    ])
    expect(run.metrics).toHaveLength(1)
  })

  it('check reports the failing example as a blocking issue', () => {
    const checked = checkVersion(inventoryVersion(), { targets })
    expect(checked.ok).toBe(false)
    expect(checked.issues).toEqual([
      expect.objectContaining({
        code: 'example_failed',
        message: expect.stringContaining('no_loops'),
      }),
    ])
  })
})
