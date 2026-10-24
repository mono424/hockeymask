/**
 * What every node form needs: the version, the node, the record types the compiler could
 * derive (also for a half-built graph), the target model, and a way to patch params.
 */

import {
  compileVersion,
  type MappingVersion,
  type NodeJson,
  nodeRefs,
  type RecordType,
  type TargetSchema,
  t,
  updateNode,
} from '@hockeymask/core'
import { createContext, useContext, useMemo } from 'react'

export interface Inspector {
  readonly version: MappingVersion
  readonly node: NodeJson
  /** Output record type of every node that compiled. */
  readonly types: Readonly<Record<string, RecordType>>
  readonly targets: TargetSchema | undefined
  readonly onChange: (version: MappingVersion) => void
}

export const InspectorContext = createContext<Inspector | null>(null)

export function useInspector(): Inspector {
  const value = useContext(InspectorContext)
  if (!value) throw new Error('useInspector outside the node inspector')
  return value
}

/** Compile once per edit for the field pickers; issues are the workspace's business. */
export function useTypes(
  version: MappingVersion,
  targets: TargetSchema | undefined,
): Readonly<Record<string, RecordType>> {
  return useMemo(
    () => compileVersion(version, { targets: targets ?? { name: '', entities: [] } }).types,
    [version, targets],
  )
}

/** A node's own params: everything but its id, op and label. */
export function paramsOf(node: NodeJson): Record<string, unknown> {
  const { id: _id, op: _op, label: _label, ...params } = node
  return params
}

/** Patch the selected node's params. */
export function useParams() {
  const { version, node, onChange } = useInspector()
  const params = paramsOf(node)
  const set = (patch: Record<string, unknown>) => {
    const next = { ...params, ...patch }
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
    onChange(updateNode(version, node.id, { params: next }))
  }
  return { params, set }
}

const EMPTY = t.record({})

/** Record type flowing into a slot of the selected node (empty while unknown). */
export function useInputType(slot = 'in'): RecordType {
  const { node, types } = useInspector()
  const ref = nodeRefs(node).find((r) => r.slot === slot)
  return (ref && types[ref.source]) || EMPTY
}

/** Display name of a node: its label, else its id. */
export function nodeName(version: MappingVersion, id: string): string {
  const node = version.nodes.find((n) => n.id === id)
  return node?.label || id
}

export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
export const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
