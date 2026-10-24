import type { ComponentType } from 'react'
import { AggregateForm } from './AggregateForm'
import { AssertForm } from './AssertForm'
import { DistinctForm } from './DistinctForm'
import { FilterForm } from './FilterForm'
import { JoinForm } from './JoinForm'
import { MapForm } from './MapForm'
import { MetricsForm } from './MetricsForm'
import { SinkForm } from './SinkForm'
import { SourceForm } from './SourceForm'
import { TransformForm } from './TransformForm'
import { UnionForm } from './UnionForm'

/** The form for each node op; every op of the engine has one. */
export const FORMS: Readonly<Record<string, ComponentType>> = {
  source: SourceForm,
  map: MapForm,
  filter: FilterForm,
  join: JoinForm,
  aggregate: AggregateForm,
  distinct: DistinctForm,
  union: UnionForm,
  sink: SinkForm,
  metrics: MetricsForm,
  assert: AssertForm,
  transform: TransformForm,
}
