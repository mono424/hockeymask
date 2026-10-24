import { describe, expect, it } from 'vite-plus/test'
import { getBench, type Run, setBench } from './testbench'

const ran = (status: 'ok' | 'partial'): Run => ({
  errors: [],
  result: { status, sinks: [], metrics: [], stats: [], issues: [] },
})
const failed: Run = { errors: ['invalid JSON'], result: null }

describe('setBench', () => {
  it('keeps the last run with a result as the baseline of the next one', () => {
    const first = ran('ok')
    const second = ran('partial')
    setBench('delta', { run: first })
    expect(getBench('delta').previous).toBeNull()
    setBench('delta', { run: second })
    expect(getBench('delta').previous).toBe(first)
    // A run that never started has nothing to compare; the baseline stays.
    setBench('delta', { run: failed })
    expect(getBench('delta').previous).toBe(second)
    setBench('delta', { run: ran('ok') })
    expect(getBench('delta').previous).toBe(second)
    // Editing feeds is not a run.
    setBench('delta', { feeds: { items: '[]' } })
    expect(getBench('delta').previous).toBe(second)
  })
})
