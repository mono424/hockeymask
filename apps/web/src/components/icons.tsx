import {
  ArrowRightLeft,
  Box,
  CircleDashed,
  Code,
  Combine,
  Fingerprint,
  Filter,
  Gauge,
  Merge,
  ShieldCheck,
  Sigma,
  Table2,
} from 'lucide-react'

const BY_OP = {
  source: Table2,
  map: ArrowRightLeft,
  filter: Filter,
  join: Merge,
  aggregate: Sigma,
  distinct: Fingerprint,
  union: Combine,
  sink: Box,
  metrics: Gauge,
  assert: ShieldCheck,
  transform: Code,
} as const

/** Icon for a node op, thin strokes like the rest of the UI. */
export function NodeIcon({ op, size = 14 }: { op: string; size?: number }) {
  const Icon = BY_OP[op as keyof typeof BY_OP] ?? CircleDashed
  return <Icon size={size} strokeWidth={1.5} />
}
