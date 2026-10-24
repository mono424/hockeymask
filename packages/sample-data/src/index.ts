/**
 * Acme Outdoor, a fictional outdoor-gear retailer, as a deterministic sample dataset for
 * the demo sources (a NetSuite account and a Snowflake inventory mart).
 *
 *     import { generate, STOCK_SNAPSHOT } from 'sample-data'
 *     const ds = generate({ scale: 0.1 })   // 200 items instead of 2,000
 *     ds.netsuite.item.rows[0]              // AO-TENT-2P-GRN
 *     ds.snowflake[STOCK_SNAPSHOT]          // ANALYTICS.INVENTORY.STOCK_SNAPSHOT
 */

export * as catalog from './catalog'
export * from './dates'
export * from './duck'
export * from './generate'
export * from './model'

/** Bump when generated output changes, so cached demo databases are rebuilt. */
export const GENERATOR_VERSION = '3'

/** Cache key for files built from a dataset: generator version, seed, scale. */
export const datasetKey = (seed: number, scale: number) =>
  `v${GENERATOR_VERSION}-seed${seed}-scale${scale}`
