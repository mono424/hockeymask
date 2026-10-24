/**
 * Unsaved edits, per mapping, in memory. The builder, the inspector and the agent's tools all
 * edit the same draft, so the agent's changes show up live and switching mappings keeps them.
 * No draft means the mapping matches what the API has saved.
 */

import type { MappingVersion } from '@hockeymask/core'
import { useSyncExternalStore } from 'react'

let drafts: Readonly<Record<string, MappingVersion>> = {}
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getDraft(graphId: string): MappingVersion | null {
  return drafts[graphId] ?? null
}

/** Set the draft, or drop it with `null` (after a save, or when the mapping is deleted). */
export function setDraft(graphId: string, version: MappingVersion | null): void {
  const { [graphId]: _dropped, ...rest } = drafts
  drafts = version ? { ...rest, [graphId]: version } : rest
  for (const listener of listeners) listener()
}

export function useDraft(graphId: string): MappingVersion | null {
  return useSyncExternalStore(subscribe, () => getDraft(graphId))
}
