import { emptyVersion } from '@hockeymask/core'
import { beforeAll, expect, it, vi } from 'vite-plus/test'
import type { GraphRecord } from '../api'
import { getDraft, setDraft } from './drafts'
import { renameMapping } from './mappings'
import { queryClient } from './query'
import { addIntegration, getState } from './store'

const saved = (name: string): GraphRecord => ({
  id: 'ns--items',
  graph: emptyVersion('ns--items', name),
  issues: [],
  updatedAt: '2026-10-04T00:00:00Z',
})

const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  const { name } = JSON.parse(init?.body as string) as { name: string }
  if (name === 'Offline') return Response.json({ detail: 'database down' }, { status: 424 })
  return Response.json(saved(name))
})

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock)
  addIntegration({
    id: 'ns',
    name: 'Acme NetSuite',
    kind: 'netsuite',
    settings: {},
    graphs: [{ id: 'ns--items', name: 'Items' }],
    createdAt: '2026-10-04T00:00:00Z',
  })
})

const listed = () => getState().integrations[0]?.graphs

it('renames the saved document, the list and an open draft together', async () => {
  setDraft('ns--items', emptyVersion('ns--items', 'Items'))
  expect(await renameMapping('ns--items', ' Item master ')).toBe('Item master')
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/graphs/ns--items',
    expect.objectContaining({ method: 'PATCH' }),
  )
  expect(queryClient.getQueryData<GraphRecord>(['graph', 'ns--items'])?.graph.name).toBe(
    'Item master',
  )
  expect(listed()).toEqual([{ id: 'ns--items', name: 'Item master' }])
  expect(getDraft('ns--items')?.name).toBe('Item master')
})

it('changes nothing when the server refuses', async () => {
  await expect(renameMapping('ns--items', 'Offline')).rejects.toMatchObject({ status: 424 })
  expect(listed()).toEqual([{ id: 'ns--items', name: 'Item master' }])
  expect(getDraft('ns--items')?.name).toBe('Item master')
})
