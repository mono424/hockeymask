/**
 * Starter mappings the wizard can create, per integration kind, for the demo sources: a new
 * integration starts with every starter of its kind. Source schemas are not part of a
 * starter: the wizard describes each source's table when it saves the mapping.
 */

import { emptyVersion, type MappingVersion, parseVersion } from '@hockeymask/core'
import type { IntegrationKind } from './integrations'
import netsuiteClassesCategory from './starters/netsuite-classes-category.json'
import netsuiteItemsProduct from './starters/netsuite-items-product.json'
import netsuiteLocationsWarehouses from './starters/netsuite-locations-warehouses.json'
import snowflakeStockInventory from './starters/snowflake-stock-inventory.json'

export interface MappingTemplate {
  key: string
  label: string
  kinds: readonly IntegrationKind[]
  build: (id: string, name: string) => MappingVersion
}

/** A starter saved as a mapping document, without its id and name. */
const saved =
  (document: object) =>
  (id: string, name: string): MappingVersion =>
    parseVersion({ ...document, id, name })

export const TEMPLATES: readonly MappingTemplate[] = [
  {
    key: 'empty',
    label: 'Empty',
    kinds: ['netsuite', 'snowflake'],
    build: (id, name) => emptyVersion(id, name),
  },
  {
    key: 'classes-category',
    label: 'Classes → Categories',
    kinds: ['netsuite'],
    build: saved(netsuiteClassesCategory),
  },
  {
    key: 'items-product',
    label: 'Items → Products',
    kinds: ['netsuite'],
    build: saved(netsuiteItemsProduct),
  },
  {
    key: 'locations-warehouses',
    label: 'Locations → Warehouses',
    kinds: ['netsuite'],
    build: saved(netsuiteLocationsWarehouses),
  },
  {
    key: 'stock-inventory',
    label: 'Stock Snapshot → Inventory Levels',
    kinds: ['snowflake'],
    build: saved(snowflakeStockInventory),
  },
]

export function templatesFor(kind: IntegrationKind): MappingTemplate[] {
  return TEMPLATES.filter((t) => t.kinds.includes(kind))
}

export function template(key: string): MappingTemplate {
  return TEMPLATES.find((t) => t.key === key) ?? (TEMPLATES[0] as MappingTemplate)
}
