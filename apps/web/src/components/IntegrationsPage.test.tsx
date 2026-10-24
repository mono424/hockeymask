import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vite-plus/test'
import type { Integration } from '../lib/integrations'
import { IntegrationsPage } from './IntegrationsPage'

const netsuite: Integration = {
  id: 'ns',
  name: 'Acme NetSuite',
  kind: 'netsuite',
  settings: { baseUrl: 'http://localhost:8101' },
  graphs: ['A', 'B', 'C', 'D', 'E'].map((n) => ({ id: `ns--${n}`, name: `Mapping ${n}` })),
  createdAt: '2026-10-04T00:00:00Z',
}
const snowflake: Integration = {
  ...netsuite,
  id: 'sf',
  name: 'Planning',
  kind: 'snowflake',
  graphs: [],
}

beforeAll(() => {
  vi.stubGlobal('fetch', async () =>
    Response.json([
      { key: 'netsuite', status: 'ok' },
      { key: 'snowflake', status: 'unreachable' },
    ]),
  )
})

afterEach(cleanup)

const renderPage = (integrations: Integration[]) => {
  const onOpen = vi.fn()
  const onAdd = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntegrationsPage integrations={integrations} onOpen={onOpen} onAdd={onAdd} />
    </QueryClientProvider>,
  )
  return { onOpen, onAdd }
}

it('shows a card per integration, with its source status and mappings', async () => {
  const { onOpen, onAdd } = renderPage([netsuite, snowflake])
  const card = screen.getByRole('button', { name: /Acme NetSuite/ })
  expect(card.textContent).toContain('5 mappings')
  expect(card.textContent).toContain('Mapping D')
  expect(card.textContent).not.toContain('Mapping E')
  expect(card.textContent).toContain('+1 more')
  expect(await screen.findByText('Connected')).toBeTruthy()
  expect(await screen.findByText('Unreachable')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Planning/ }).textContent).toContain('0 mappings')

  fireEvent.click(card)
  expect(onOpen).toHaveBeenCalledWith(netsuite)
  fireEvent.click(screen.getByRole('button', { name: 'Add integration' }))
  expect(onAdd).toHaveBeenCalled()
})

it('invites adding the first integration when there is none', () => {
  const { onAdd } = renderPage([])
  fireEvent.click(screen.getByRole('button', { name: 'Add your first integration' }))
  expect(onAdd).toHaveBeenCalled()
})
