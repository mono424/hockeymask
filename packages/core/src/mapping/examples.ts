/**
 * Fixtures (arch.md, "examples"): relations in, keyed by source node id, and relations
 * out, keyed by any node id, so a multi-step graph is tested at the step that matters. An
 * expected relation is compared as a set on the fields it lists. A fixture also fails when
 * its run stops (an `assert` or expectation with `stop`) or a node fails.
 *
 * Fixtures run at sample scale, so production `count` envelopes are skipped. Dates compare
 * as ISO instants; sink rows hold what would be written (`YYYY-MM-DD` for date fields).
 */

import type { Plan } from './compile'
import { execute, type RunResult } from './execute'
import type { RunIssue } from './nodes'
import { Instant, isTimeZone } from './time'
import { canonicalKey, type Json, toJson, type Val } from './values'

export interface NodeDiff {
  readonly node: string
  /** Expected records the run did not produce. */
  readonly missing: readonly Json[]
  /** Produced records the fixture does not list. */
  readonly unexpected: readonly Json[]
}

export interface ExampleResult {
  readonly index: number
  readonly name?: string
  readonly passed: boolean
  /** Why the fixture failed, apart from relation differences. */
  readonly failures: readonly string[]
  readonly diffs: readonly NodeDiff[]
  readonly issues: readonly RunIssue[]
  readonly run?: RunResult
}

const DEFAULT_NOW = '2000-01-01T00:00:00Z'

export function runExamples(plan: Plan): ExampleResult[] {
  return plan.version.examples.map((example, index) => {
    const failures: string[] = []
    const head = { index, ...(example.name ? { name: example.name } : {}) }
    const sources = new Set(plan.nodes.filter((n) => n.op === 'source').map((n) => n.id))
    const nodes = new Set(plan.nodes.map((n) => n.id))
    for (const id of Object.keys(example.sources)) {
      if (!sources.has(id)) failures.push(`sources names '${id}', which is not a source node`)
    }
    for (const id of Object.keys(example.expect)) {
      if (!nodes.has(id)) failures.push(`expect names unknown node '${id}'`)
    }
    if (plan.usesClock && example.now === undefined) {
      failures.push('the graph reads the clock (today/now), so the example needs "now"')
    }
    const now = Instant.parse(example.now ?? DEFAULT_NOW)
    if (!now) failures.push(`now '${example.now}' is not an ISO instant`)
    const tz = example.tz ?? 'UTC'
    if (!isTimeZone(tz)) failures.push(`unknown time zone '${tz}'`)
    if (failures.length) return { ...head, passed: false, failures, diffs: [], issues: [] }

    const run = execute(
      plan,
      example.sources,
      { now: now as Instant, tz },
      { retain: true, fixture: true },
    )
    if (run.status === 'stopped') {
      const why = run.issues
        .filter((i) => i.action === 'stop')
        .map((i) => `${i.node}: ${i.message}`)
      failures.push(`run stopped${why.length ? `: ${why.join('; ')}` : ''}`)
    }
    for (const s of run.stats) {
      if (s.status === 'failed') {
        const why = run.issues.filter((i) => i.node === s.node).map((i) => i.message)
        failures.push(`${s.node} failed: ${why.join('; ')}`)
      }
    }

    const diffs: NodeDiff[] = []
    for (const [id, expected] of Object.entries(example.expect)) {
      const actual = run.outputs?.[id]
      if (!actual) {
        failures.push(`${id} produced no output`)
        continue
      }
      if (expected.length === 0) {
        if (actual.length) diffs.push({ node: id, missing: [], unexpected: actual.map(toJson) })
        continue
      }
      const fields = Object.keys(expected[0] as object).sort()
      if (expected.some((r) => Object.keys(r).sort().join('\u0000') !== fields.join('\u0000'))) {
        failures.push(`expected rows of ${id} must all list the same fields`)
        continue
      }
      const project = (r: Readonly<Record<string, Val>>) =>
        Object.fromEntries(fields.map((f) => [f, toJson(r[f] ?? null)])) as Json
      const want = new Map(
        expected.map((r) => [
          canonicalKey(project(r as Record<string, Val>) as Val),
          project(r as Record<string, Val>),
        ]),
      )
      const got = new Map(actual.map((r) => [canonicalKey(project(r) as Val), project(r)]))
      const missing = [...want].filter(([k]) => !got.has(k)).map(([, r]) => r)
      const unexpected = [...got].filter(([k]) => !want.has(k)).map(([, r]) => r)
      if (missing.length || unexpected.length) diffs.push({ node: id, missing, unexpected })
    }
    return {
      ...head,
      passed: failures.length === 0 && diffs.length === 0,
      failures,
      diffs,
      issues: run.issues,
      run,
    }
  })
}
