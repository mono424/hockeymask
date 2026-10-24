import { expect, it } from 'vite-plus/test'
import { defaultSettings, graphId, slugify } from './integrations'

it('derives unique mapping document ids per integration', () => {
  expect(slugify('Items → product')).toBe('items-product')
  const first = graphId('acme-netsuite-ab12', 'Items → product', [])
  expect(first).toBe('acme-netsuite-ab12--items-product')
  expect(graphId('acme-netsuite-ab12', 'Items → product', [{ id: first, name: 'x' }])).toBe(
    `${first}-2`,
  )
})

it('auto-fills settings per kind', () => {
  expect(defaultSettings('snowflake')).toMatchObject({ database: 'ANALYTICS', schema: 'INVENTORY' })
  expect(defaultSettings('netsuite').baseUrl).toBe('http://localhost:8101')
})
