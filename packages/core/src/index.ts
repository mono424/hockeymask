/**
 * @hockeymask/core: the logic half of hockeymask.
 *
 * - schema: what a source has (Table, Column) and what the host wants (TargetSchema)
 * - connector: the contract a source connector fulfils (list, describe, sample, read, query)
 * - mapping: the mapping engine; versions as typed DAGs, compiled and executed over snapshots
 */

export * from './connector'
export * from './mapping'
export * from './schema'
