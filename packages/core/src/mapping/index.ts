/**
 * The mapping engine (see arch.md): a mapping version is a typed DAG of collection nodes whose
 * `map` nodes run per-field record pipelines. Compile it against the host's target model,
 * then execute the plan over a frozen snapshot of its sources.
 */

export * from './check'
export * from './compile'
export * from './context'
export * from './document'
export * from './edit'
export * from './examples'
export * from './execute'
export * from './graph'
export * from './jsonschema'
export * from './nodes'
export * from './ops'
export * from './pipeline'
export * from './predicate'
export * from './result'
export * from './sugar'
export * from './time'
export * from './types'
export * from './values'
