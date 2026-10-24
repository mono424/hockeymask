/** Renaming or deleting a mapping touches the list, the saved document and the draft together. */

import { useState } from 'react'
import { ApiError, api } from '../api'
import { getDraft, setDraft } from './drafts'
import type { GraphRef } from './integrations'
import { queryClient } from './query'
import { removeGraph, renameGraph } from './store'

/**
 * The server first, so a failed rename changes nothing here. A mapping that was never saved
 * has no document yet (404): only the list and the draft carry its name.
 */
export async function renameMapping(graphId: string, name: string): Promise<string> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A mapping needs a name.')
  try {
    queryClient.setQueryData(['graph', graphId], await api.renameGraph(graphId, trimmed))
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error
  }
  renameGraph(graphId, trimmed)
  const draft = getDraft(graphId)
  if (draft) setDraft(graphId, { ...draft, name: trimmed })
  return trimmed
}

/** The server first, as for a rename; a mapping that was never saved (404) only leaves the list. */
export async function deleteMapping(graphId: string): Promise<void> {
  try {
    await api.deleteGraph(graphId)
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error
  }
  removeGraph(graphId)
  setDraft(graphId, null)
  queryClient.removeQueries({ queryKey: ['graph', graphId] })
}

/** Inline rename of one mapping: `start` opens the editor, `finish` renames if the name changed. */
export function useRename(graph: GraphRef) {
  const [editing, setEditing] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const start = () => {
    setFailed(null)
    setEditing(true)
  }
  const finish = (name: string) => {
    setEditing(false)
    if (name && name !== graph.name) {
      renameMapping(graph.id, name).catch((error: Error) => setFailed(error.message))
    }
  }
  return { editing, failed, start, finish }
}
