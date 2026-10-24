/**
 * The executor (arch.md, "Execution model"). Runs a compiled plan over a frozen snapshot:
 * every node once, in topological order, each edge held only until its last consumer has run.
 * Nothing is written: sinks return their rows, and the host writes those with status `write`.
 *
 * Failure stays as local as lineage allows. A failed node skips what depends on it while
 * independent branches proceed; `skip_downstream` holds back exactly the sinks below a node;
 * `stop` (or `on_error: fail_sync`) holds back every sink, but nodes feeding `metrics` still
 * run, because metrics describe the run and matter most when it stops.
 */

import type { RunContext } from './context'
import type { Plan } from './compile'
import type { Metric, NodeRun, RunIssue, SinkWrite } from './nodes'
import { Instant } from './time'
import { type Relation, toJson } from './values'

export interface RunInput {
  /** The run's frozen clock: an instant, or an ISO string with an offset. */
  readonly now: Instant | string
  /** IANA time zone for calendar math; defaults to UTC. */
  readonly tz?: string
  readonly locale?: string
  readonly syncRunId?: string
  /** Previous output counts per node id, for `count.shiftRatio`. */
  readonly baseline?: Readonly<Record<string, number>>
}

export interface ExecuteOptions {
  /** Keep every node's output in the result (previews, fixtures). */
  readonly retain?: boolean
  /** Fixture mode: run every node even after a stop, skip production `count` envelopes. */
  readonly fixture?: boolean
  /** Elapsed-time clock for statistics; defaults to `performance.now`. */
  readonly clock?: () => number
}

export type NodeStatus = 'ok' | 'failed' | 'upstream_failed' | 'stopped'

export interface NodeStats {
  readonly node: string
  readonly op: string
  readonly status: NodeStatus
  readonly rowsIn: number
  readonly rowsOut: number
  readonly skipped: number
  readonly changed: number
  readonly ms: number
}

export type SinkStatus = 'write' | 'held' | 'stopped' | 'failed' | 'upstream_failed'

export interface SinkResult {
  readonly sink: string
  readonly status: SinkStatus
  /** Present only with status `write`. */
  readonly write?: SinkWrite
}

export interface RunResult {
  /** `stopped`: nothing may be written. `partial`: some sink is not `write`. */
  readonly status: 'ok' | 'partial' | 'stopped'
  readonly sinks: readonly SinkResult[]
  readonly metrics: readonly Metric[]
  readonly stats: readonly NodeStats[]
  readonly issues: readonly RunIssue[]
  /** Every node's output, with `retain`. Sinks hold the rows they would write. */
  readonly outputs?: Readonly<Record<string, Relation>>
}

export type Snapshot = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>

/** Sources the host must read, once each, before a run. */
export function readPlan(plan: Plan): { node: string; system: string; entity: string }[] {
  return plan.nodes
    .filter((n) => n.op === 'source')
    .map((n) => ({ node: n.id, system: String(n.params.system), entity: String(n.params.entity) }))
}

/** Read every source once and freeze the result into a snapshot. */
export async function readSnapshot(
  plan: Plan,
  read: (source: {
    node: string
    system: string
    entity: string
  }) => Promise<readonly Readonly<Record<string, unknown>>[]>,
): Promise<Snapshot> {
  const snapshot: Record<string, readonly Readonly<Record<string, unknown>>[]> = {}
  for (const source of readPlan(plan))
    snapshot[source.node] = Object.freeze([...(await read(source))])
  return Object.freeze(snapshot)
}

export function execute(
  plan: Plan,
  snapshot: Snapshot,
  run: RunInput,
  options: ExecuteOptions = {},
): RunResult {
  const now = typeof run.now === 'string' ? Instant.parse(run.now) : run.now
  if (!now) throw new Error(`run.now '${String(run.now)}' is not an ISO instant`)
  const clock = options.clock ?? (() => performance.now())
  const ctx: RunContext = Object.freeze({
    now,
    tz: run.tz ?? 'UTC',
    locale: run.locale ?? 'en',
    snapshot: snapshot as RunContext['snapshot'],
    params: plan.version.params,
    tables: plan.version.tables,
    run: {
      syncRunId: run.syncRunId ?? '',
      mappingVersionId: `${plan.version.id}@${plan.version.version}`,
    },
  })

  const outputs = new Map<string, Relation>()
  const retained: Record<string, Relation> = {}
  const status = new Map<string, NodeStatus>()
  const stats: NodeStats[] = []
  const issues: RunIssue[] = []
  const writes = new Map<string, SinkWrite>()
  const metrics: Metric[] = []
  const held = new Set<string>()
  let stopped = false

  for (const [i, node] of plan.nodes.entries()) {
    const record = (s: NodeStatus, extra: Partial<NodeStats> = {}) => {
      status.set(node.id, s)
      stats.push({
        node: node.id,
        op: node.op,
        status: s,
        rowsIn: 0,
        rowsOut: 0,
        skipped: 0,
        changed: 0,
        ms: 0,
        ...extra,
      })
    }
    // Nodes feeding metrics read only nodes feeding metrics, so never a stopped input.
    if (stopped && !options.fixture && !node.feedsMetrics) record('stopped')
    else if (node.inputs.some((id) => status.get(id) !== 'ok')) record('upstream_failed')
    else {
      const rowsIn = node.inputs.reduce((n, id) => n + (outputs.get(id) as Relation).length, 0)
      const start = clock()
      const result = node.run((id) => outputs.get(id) as Relation, ctx, {
        ...(run.baseline?.[node.id] === undefined ? {} : { baseline: run.baseline[node.id] }),
        ...(options.fixture ? { skipCount: true } : {}),
      })
      if (!result.ok) {
        const e = result.error
        issues.push({
          node: node.id,
          code: e.code,
          message: e.message,
          ...(e.samples ? { samples: e.samples } : {}),
        })
        issues.push(...(e.issues ?? []))
        if (e.stop) stopped = true
        record('failed', { rowsIn, ms: clock() - start })
      } else {
        let out: NodeRun = result.value
        if (node.check) {
          const checked = node.check(out.rows, ctx, {
            ...(run.baseline?.[node.id] === undefined ? {} : { baseline: run.baseline[node.id] }),
            ...(options.fixture ? { skipCount: true } : {}),
          })
          out = {
            ...out,
            rows: checked.rows,
            changed: (out.changed ?? 0) + checked.changed,
            issues: [...(out.issues ?? []), ...checked.issues],
            stop: out.stop || checked.stop,
            skipDownstream: out.skipDownstream || checked.skipDownstream,
          }
        }
        issues.push(...(out.issues ?? []))
        if (out.stop) stopped = true
        if (out.skipDownstream) for (const s of node.sinks) held.add(s)
        if (out.write) writes.set(node.id, out.write)
        // A metric reports its rows as the node's checks left them.
        if (out.metric) {
          metrics.push(
            node.check
              ? { ...out.metric, rows: out.rows.map((r) => toJson(r) as Metric['rows'][number]) }
              : out.metric,
          )
        }
        outputs.set(node.id, out.rows)
        if (options.retain) retained[node.id] = out.rows
        record('ok', {
          rowsIn,
          rowsOut: out.rows.length,
          skipped: out.skipped ?? 0,
          changed: out.changed ?? 0,
          ms: clock() - start,
        })
      }
    }
    for (const id of node.inputs) if (plan.lastUse.get(id) === i) outputs.delete(id)
  }

  const sinks: SinkResult[] = plan.nodes
    .filter((n) => n.effect === 'sink')
    .map((n) => {
      const s = status.get(n.id)
      const write = writes.get(n.id)
      if (stopped) return { sink: n.id, status: 'stopped' }
      if (s === 'failed') return { sink: n.id, status: 'failed' }
      if (s !== 'ok' || !write) return { sink: n.id, status: 'upstream_failed' }
      if (held.has(n.id)) return { sink: n.id, status: 'held' }
      return { sink: n.id, status: 'write', write }
    })

  return {
    status: stopped
      ? 'stopped'
      : sinks.every((s) => s.status === 'write') && [...status.values()].every((s) => s === 'ok')
        ? 'ok'
        : 'partial',
    sinks,
    metrics,
    stats,
    issues,
    ...(options.retain ? { outputs: retained } : {}),
  }
}
