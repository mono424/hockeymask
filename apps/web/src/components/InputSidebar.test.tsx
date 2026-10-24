import { emptyVersion } from '@hockeymask/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vite-plus/test'
import { addIntegration, getState } from '../lib/store'
import { GraphItem } from './InputSidebar'

const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === 'DELETE') return new Response(null, { status: 204 })
  const { name } = JSON.parse(init?.body as string) as { name: string }
  return Response.json({ id: 'ns--items', graph: emptyVersion('ns--items', name), issues: [] })
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

afterEach(() => {
  cleanup()
  fetchMock.mockClear()
  vi.restoreAllMocks()
})

const renderItem = () =>
  render(<GraphItem integrationId="ns" graph={{ id: 'ns--items', name: 'Items' }} active />)

it('renames a mapping from the pencil on its row', async () => {
  renderItem()
  fireEvent.click(screen.getByRole('button', { name: 'Rename Items' }))
  const input = screen.getByRole('textbox', { name: 'Mapping name' })
  expect(input).toHaveProperty('value', 'Items')
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: '  Item master ' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.queryByRole('textbox')).toBeNull()
  await waitFor(() =>
    expect(getState().integrations[0]?.graphs).toEqual([{ id: 'ns--items', name: 'Item master' }]),
  )
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/graphs/ns--items',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Item master' }) }),
  )
})

it('leaves the name alone on Escape', () => {
  renderItem()
  fireEvent.click(screen.getByRole('button', { name: 'Rename Items' }))
  const input = screen.getByRole('textbox', { name: 'Mapping name' })
  fireEvent.change(input, { target: { value: 'Something else' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByText('Items')).toBeTruthy()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('keeps the mapping when the delete is not confirmed', () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  renderItem()
  fireEvent.click(screen.getByRole('button', { name: 'Delete Items' }))
  expect(fetchMock).not.toHaveBeenCalled()
  expect(getState().integrations[0]?.graphs).toHaveLength(1)
})

it('deletes a mapping and its saved document from the bin on its row', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderItem()
  fireEvent.click(screen.getByRole('button', { name: 'Delete Items' }))
  expect(confirm).toHaveBeenCalledWith('Delete mapping “Items” and its saved document?')
  await waitFor(() => expect(getState().integrations[0]?.graphs).toEqual([]))
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/graphs/ns--items',
    expect.objectContaining({ method: 'DELETE' }),
  )
})
