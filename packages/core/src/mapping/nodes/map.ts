/**
 * `map`: where the scopes meet. Splits a collection into records, runs one field pipeline per
 * target field with the record as the `extract` scope, and collects the results.
 *
 * `keep: "all"` passes the input fields through alongside the new ones, except those listed in
 * `drop` (the `lookup_entity` rewrite drops its helper fields that way). A failing field
 * applies `on_error`:
 * `null` writes null, `skip_field` leaves the field out, `skip_record` (default) drops the
 * record, `fail_sync` fails the node and stops the run.
 */

import { z } from 'zod'
import { OnError } from '../document'
import { type CompiledPipeline, compileSteps } from '../pipeline'
import { err, ok } from '../result'
import { type MType, stripNull, t } from '../types'
import { OMIT, type Rec, type Val } from '../values'
import { defineNode, nodeId, type NodeIssue, type Origin, type RunIssue } from './def'

const field = z.strictObject({ key: z.string().min(1), pipeline: z.array(z.unknown()).min(1) })

const params = z.strictObject({
  in: nodeId,
  fields: z.array(field).min(1),
  keep: z.enum(['none', 'all']).optional(),
  drop: z.array(z.string().min(1)).optional(),
  on_error: OnError.optional(),
})

const SAMPLES = 5

export const mapNode = defineNode({
  op: 'map',
  label: 'Map fields',
  category: 'transform',
  description: 'One output field per pipeline, computed from each input record.',
  slots: [{ id: 'in', label: 'In', path: ['in'] }],
  output: true,
  defaults: () => ({ in: '', fields: [] }),
  params,
  compile: (p, env) => {
    const input = env.input(p.in)
    const renv = env.recordEnv(input.type)
    const policy = p.on_error ?? env.version.onError ?? 'skip_record'
    const issues: NodeIssue[] = []

    const drop = new Set(p.drop ?? [])
    if (drop.size > 0 && p.keep !== 'all')
      issues.push({ message: 'drop applies only with keep: "all"' })
    for (const name of drop) {
      if (!Object.hasOwn(input.type.fields, name))
        issues.push({ message: `drop: unknown field '${name}'` })
    }
    const keep = p.keep === 'all' ? Object.keys(input.type.fields).filter((f) => !drop.has(f)) : []

    const seen = new Set<string>()
    const compiled: { key: string; pipeline: CompiledPipeline }[] = []
    for (const f of p.fields) {
      if (seen.has(f.key))
        issues.push({ message: `field '${f.key}' is defined twice`, field: f.key })
      seen.add(f.key)
      const c = compileSteps(f.pipeline, renv)
      if (c.ok) compiled.push({ key: f.key, pipeline: c.value })
      else issues.push({ message: c.error.message, field: f.key, step: c.error.step })
    }
    if (issues.length) return { ok: false, error: issues }

    const fields: Record<string, MType> = {}
    const origins: Record<string, Origin> = {}
    for (const name of keep) {
      fields[name] = input.type.fields[name] as MType
      origins[name] = input.origins[name] as Origin
    }
    for (const { key, pipeline } of compiled) {
      const soft = pipeline.fallible && (policy === 'null' || policy === 'skip_field')
      const omittable = pipeline.omittable || (pipeline.fallible && policy === 'skip_field')
      fields[key] = soft ? t.nullable(pipeline.type) : pipeline.type
      origins[key] = {
        node: env.id,
        field: key,
        omittable,
        ...(omittable
          ? { present: pipeline.omittable ? stripNull(pipeline.type) : pipeline.type }
          : {}),
      }
    }

    return ok({
      output: {
        type: t.record(fields),
        origins,
        canSkip: policy === 'skip_record' && compiled.some((c) => c.pipeline.fallible),
      },
      run: (inputs, ctx) => {
        const errors = new Map<
          string,
          { field: string; code: string; count: number; samples: string[] }
        >()
        const rows: Rec[] = []
        let skipped = 0
        for (const record of inputs(p.in)) {
          const rc = { ...ctx, record }
          const out: Record<string, Val> = {}
          for (const name of keep) if (Object.hasOwn(record, name)) out[name] = record[name] as Val
          let drop = false
          for (const { key, pipeline } of compiled) {
            const r = pipeline.run(null, rc)
            if (r.ok) {
              if (r.value === OMIT) delete out[key]
              else out[key] = r.value
              continue
            }
            const detail = `step ${r.error.step} ${r.error.op}: ${r.error.detail}`
            if (policy === 'fail_sync') {
              return err({ code: r.error.code, message: `${key} ${detail}`, stop: true })
            }
            const k = `${key}\u0000${r.error.code}`
            const e = errors.get(k) ?? { field: key, code: r.error.code, count: 0, samples: [] }
            e.count += 1
            if (e.samples.length < SAMPLES) e.samples.push(detail)
            errors.set(k, e)
            if (policy === 'null') out[key] = null
            else if (policy === 'skip_field') delete out[key]
            else {
              drop = true
              break
            }
          }
          if (drop) skipped += 1
          else rows.push(out)
        }
        const issues: RunIssue[] = [...errors.values()].map((e) => ({
          node: env.id,
          code: e.code,
          field: e.field,
          message: `${e.field}: ${e.count} records failed (${policy})`,
          count: e.count,
          samples: e.samples,
        }))
        return ok({ rows, skipped, issues })
      },
    })
  },
})
