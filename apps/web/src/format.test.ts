import { expect, it } from 'vite-plus/test'
import { formatCount, shortTableName } from './format'

it('formats counts', () => {
  expect(formatCount(292975)).toBe('292,975')
  expect(formatCount(null)).toBe('—')
})

it('shortens fully qualified table names', () => {
  expect(shortTableName('ANALYTICS.INVENTORY.STOCK_SNAPSHOT')).toBe('STOCK_SNAPSHOT')
  expect(shortTableName('item')).toBe('item')
})
