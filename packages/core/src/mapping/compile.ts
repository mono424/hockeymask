/**
 * The graph compiler (arch.md, "Type checking"): walks nodes in topological order, threading
 * record types along edges, and compiles each node into a closure in the same pass. The
 * result is one plan per version; a run never touches JSON.
 *
 * Every problem is collected in one pass and located by node, field and step. A node whose
 * inputs failed to compile is skipped silently, so one mistake does not cascade.
 */

import { type GraphEnv, recordEnv } from './context'
import type { MappingVersion, NodeJson } from './document'
import { type Checker, compileExpectation } from './expect'
import { consumers, findGraphCycle, inputIds, nodeRefs, topologicalOrder } from './graph'
import { type CompiledNode, nodeRegistry, type NodeEnv, type NodeOutput } from './nodes'
import type { CompileIssue } from './result'
import { normalizeVersion } from './sugar'
import type { RecordType } from './types'

export interface PlannedNode {
  readonly id: string
  readonly op: string
  /** Parsed params. */
  readonly params: Readonly<Record<string, unknown>>
  readonly inputs: readonly string[]
  readonly output: NodeOutput | null
  readonly effect?: 'sink' | 'metrics' | 'check'
  readonly run: CompiledNode['run']
  /** The node's `expect` entry, compiled. */
  readonly check?: Checker
  /** Sinks downstream of this node, itself included: the reach of `skip_downstream`. */
  readonly sinks: readonly string[]
  /** Upstream of (or is) a `metrics` node: keeps running after a `stop`. */
  readonly feedsMetrics: boolean
}

export interface Plan {
  /** The normalized version the plan was compiled from. */
  readonly version: MappingVersion
  readonly nodes: readonly PlannedNode[]
  /** Index of the last node reading each node's output; the edge is freed after it. */
  readonly lastUse: ReadonlyMap<string, number>
  /** Some predicate reads the run clock (`today`, `now`). */
  readonly usesClock: boolean
}

/**
 * `types` holds the output record type of every node that compiled, also when others did
 * not, so an editor can offer the fields reaching a node while the graph is half built.
 */
export type CompileResult =
  | {
      readonly ok: true
      readonly plan: Plan
      readonly issues: readonly []
      readonly types: Readonly<Record<string, RecordType>>
    }
  | {
      readonly ok: false
      readonly issues: readonly CompileIssue[]
      readonly types: Readonly<Record<string, RecordType>>
    }

function paramsOf(node: NodeJson): Record<string, unknown> {
  const { id: _i, op: _o, label: _l, ...rest } = node
  return rest
}

/**
 * Structural rules that need no types: unique ids, known ops, resolvable references,
 * acyclic, no dead nodes, addressable `expect` keys. Checked in the browser too.
 */
export function structuralIssues(version: MappingVersion): CompileIssue[] {
  const issues: CompileIssue[] = []
  const byId = new Map<string, NodeJson>()
  for (const node of version.nodes) {
    if (byId.has(node.id))
      issues.push({ code: 'duplicate_id', message: `id '${node.id}' is used twice`, node: node.id })
    byId.set(node.id, node)
  }
  for (const node of version.nodes) {
    const def = Object.hasOwn(nodeRegistry, node.op) ? nodeRegistry[node.op] : undefined
    if (!def) {
      issues.push({ code: 'unknown_op', message: `unknown node op '${node.op}'`, node: node.id })
      continue
    }
    const refs = nodeRefs(node)
    for (const slot of def.slots) {
      if (!slot.optional && !refs.some((r) => r.slot === slot.id)) {
        issues.push({
          code: 'missing_input',
          message: `input '${slot.label}' is not connected`,
          node: node.id,
        })
      }
    }
    for (const ref of refs) {
      const source = byId.get(ref.source)
      if (!source) {
        issues.push({
          code: 'dangling_ref',
          message: `'${ref.slot}' refers to unknown node '${ref.source}'`,
          node: node.id,
        })
      } else if (nodeRegistry[source.op] && !nodeRegistry[source.op]?.output) {
        issues.push({
          code: 'dangling_ref',
          message: `'${ref.source}' (${source.op}) has no output to read`,
          node: node.id,
        })
      }
    }
  }
  const cycle = findGraphCycle(version.nodes)
  if (cycle) issues.push({ code: 'cycle', message: `cycle: ${cycle.join(' -> ')}`, node: cycle[0] })

  // No dead nodes: every node must reach a sink, metrics or assert.
  const live = new Set<string>()
  const effectful = (n: NodeJson) => nodeRegistry[n.op]?.effect !== undefined
  const stack = version.nodes.filter(effectful).map((n) => n.id)
  const prev = new Map(version.nodes.map((n) => [n.id, inputIds(n)]))
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (live.has(id)) continue
    live.add(id)
    stack.push(...(prev.get(id) ?? []))
  }
  for (const node of version.nodes) {
    if (!live.has(node.id) && nodeRegistry[node.op]) {
      issues.push({
        code: 'dead_node',
        message: 'reaches no sink, metrics or assert',
        node: node.id,
      })
    }
  }
  for (const id of Object.keys(version.expect)) {
    if (!byId.has(id))
      issues.push({
        code: 'unknown_reference',
        message: `expect names unknown node '${id}'`,
        field: id,
      })
  }
  return issues
}

/** Compile a version against the host's environment. */
export function compileVersion(input: MappingVersion, env: GraphEnv): CompileResult {
  const normalized = normalizeVersion(input, env)
  const version = normalized.version
  const issues: CompileIssue[] = [...normalized.issues, ...structuralIssues(version)]
  if (issues.some((i) => i.code === 'cycle' || i.code === 'duplicate_id'))
    return { ok: false, issues, types: {} }

  const byId = new Map(version.nodes.map((n) => [n.id, n]))
  const clock = { used: false }
  const outputs = new Map<string, NodeOutput>()
  const compiled = new Map<string, CompiledEntry>()
  const renv = (record: RecordType) =>
    recordEnv(record, {
      params: version.params,
      tables: version.tables,
      functions: env.functions ?? {},
      clock,
    })

  for (const id of topologicalOrder(version.nodes)) {
    const node = byId.get(id) as NodeJson
    const def = Object.hasOwn(nodeRegistry, node.op) ? nodeRegistry[node.op] : undefined
    if (!def) continue
    const refs = inputIds(node)
    if (refs.some((r) => !outputs.has(r))) continue // blocked by an upstream problem

    const parsed = def.params.safeParse(paramsOf(node))
    if (!parsed.success) {
      for (const x of parsed.error.issues) {
        issues.push({
          code: 'invalid_params',
          message: `${x.path.length ? `${x.path.join('.')}: ` : ''}${x.message}`,
          node: id,
        })
      }
      continue
    }
    const exp = version.expect[id]
    const nodeEnv: NodeEnv = {
      id,
      graph: env,
      version,
      ...(exp ? { expect: exp } : {}),
      clock,
      input: (ref) => outputs.get(ref) as NodeOutput,
      recordEnv: renv,
    }
    const result = def.compile(parsed.data, nodeEnv)
    if (!result.ok) {
      for (const x of result.error) {
        issues.push({
          code: x.code ?? 'type_error',
          message: x.message,
          node: x.node ?? id,
          ...(x.field === undefined ? {} : { field: x.field }),
          ...(x.step === undefined ? {} : { step: x.step }),
        })
      }
      continue
    }
    let output = result.value.output
    let check: Checker | undefined
    if (exp) {
      if (!output) {
        issues.push({
          code: 'invalid_expectation',
          message: `${node.op} has no output to expect on`,
          node: id,
        })
        continue
      }
      const e = compileExpectation(id, exp, output, renv)
      if (!e.ok) {
        for (const x of e.error) {
          // Every expectation issue names its clause.
          issues.push({
            code: 'invalid_expectation',
            message: x.message,
            node: id,
            field: x.field as string,
          })
        }
        continue
      }
      output = e.value.output
      check = e.value.check
    }
    if (output) outputs.set(id, output)
    compiled.set(id, {
      node: { ...result.value, output },
      params: parsed.data as Record<string, unknown>,
      ...(check ? { check } : {}),
    })
  }

  issues.push(...sinkIssues(compiled), ...skipIssues(version, compiled))
  const types = Object.fromEntries([...outputs].map(([id, output]) => [id, output.type]))
  if (issues.length > 0) return { ok: false, issues: dedupe(issues), types }
  return { ok: true, plan: plan(version, compiled, clock.used), issues: [], types }
}

interface CompiledEntry {
  readonly node: CompiledNode
  readonly params: Record<string, unknown>
  readonly check?: Checker
}

type Compiled = ReadonlyMap<string, CompiledEntry>

/** Sugar that fails to expand is reported by normalization and again by the step compiler. */
function dedupe(issues: readonly CompileIssue[]): CompileIssue[] {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const key = JSON.stringify([i.node, i.field, i.step, i.message])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** One sink per target entity (structural rule 4): resolve overlaps with a union. */
function sinkIssues(compiled: Compiled): CompileIssue[] {
  const writers = new Map<string, string[]>()
  for (const [id, c] of compiled) {
    for (const entity of c.node.writes ?? [])
      writers.set(entity, [...(writers.get(entity) ?? []), id])
  }
  return [...writers]
    .filter(([, sinks]) => sinks.length > 1)
    .map(([entity, sinks]) => ({
      code: 'duplicate_sink' as const,
      message: `${sinks.join(' and ')} both write ${entity}; union their inputs into one sink`,
      node: sinks[1] as string,
    }))
}

/**
 * A map that can drop records upstream of a join or aggregate can flip its result, so the
 * first join or aggregate on every path from it must declare `tolerate_skips`.
 */
function skipIssues(version: MappingVersion, compiled: Compiled): CompileIssue[] {
  const next = consumers(version.nodes)
  const byId = new Map(version.nodes.map((n) => [n.id, n]))
  const issues: CompileIssue[] = []
  for (const [id, c] of compiled) {
    // Only a map drops records; nodes downstream of it may carry its `canSkip` along.
    if (byId.get(id)?.op !== 'map' || !c.node.output?.canSkip) continue
    const seen = new Set<string>()
    const stack = [...(next.get(id) as string[])]
    while (stack.length > 0) {
      const n = stack.pop() as string
      if (seen.has(n)) continue
      seen.add(n)
      const node = byId.get(n) as NodeJson
      const def = nodeRegistry[node.op]
      if (def?.toleratesSkips) {
        const params = compiled.get(n)?.params
        if (params && !def.toleratesSkips(params)) {
          issues.push({
            code: 'skip_tolerance',
            message: `${id} can drop records (on_error skip_record with a fallible field); set tolerate_skips: true here or change ${id}'s on_error`,
            node: n,
          })
        }
        continue
      }
      stack.push(...(next.get(n) as string[]))
    }
  }
  return issues
}

function plan(version: MappingVersion, compiled: Compiled, usesClock: boolean): Plan {
  const order = topologicalOrder(version.nodes)
  const byId = new Map(version.nodes.map((n) => [n.id, n]))
  const next = consumers(version.nodes)
  const lastUse = new Map<string, number>()
  for (const [i, id] of order.entries()) {
    for (const ref of inputIds(byId.get(id) as NodeJson)) lastUse.set(ref, i)
  }
  const sinksBelow = new Map<string, string[]>()
  const metricsBelow = new Map<string, boolean>()
  for (const id of [...order].reverse()) {
    const op = (byId.get(id) as NodeJson).op
    // Reverse topological order: every consumer is done before the node it reads.
    const below = next.get(id) as string[]
    const sinks = below.flatMap((b) => sinksBelow.get(b) as string[])
    sinksBelow.set(id, [...new Set(op === 'sink' ? [id, ...sinks] : sinks)].sort())
    metricsBelow.set(id, op === 'metrics' || below.some((b) => metricsBelow.get(b)))
  }
  const nodes: PlannedNode[] = order.map((id) => {
    const node = byId.get(id) as NodeJson
    const c = compiled.get(id) as CompiledEntry
    const def = nodeRegistry[node.op]
    return {
      id,
      op: node.op,
      params: c.params,
      inputs: inputIds(node),
      output: c.node.output,
      ...(def?.effect ? { effect: def.effect } : {}),
      run: c.node.run,
      ...(c.check ? { check: c.check } : {}),
      sinks: sinksBelow.get(id) as string[],
      feedsMetrics: metricsBelow.get(id) as boolean,
    }
  })
  return { version, nodes, lastUse, usesClock }
}
