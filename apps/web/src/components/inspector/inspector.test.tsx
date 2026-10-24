import { emptyVersion, type MappingVersion, parseVersion } from '@hockeymask/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { parseCondition, serializeCondition } from './ConditionEditor'
import { InspectorOverlay } from './InspectorOverlay'
import { asSteps, stepSummary } from './PipelineEditor'

function wrap(children: ReactNode) {
  // No network in tests: queries stay pending and the forms render without lists.
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const version: MappingVersion = parseVersion({
  id: 'v',
  expectedSchema: {
    items: {
      type: 'object',
      required: ['itemid'],
      properties: { itemid: { type: 'string' }, width_mm: { type: 'number' } },
    },
  },
  nodes: [
    { id: 'items', op: 'source', system: 'netsuite', entity: 'item' },
    {
      id: 'products',
      op: 'map',
      label: 'Products',
      in: 'items',
      fields: [
        { key: 'sku', pipeline: [{ op: 'extract', path: 'itemid' }] },
        {
          key: 'width',
          pipeline: [
            { op: 'extract', path: 'width_mm' },
            { op: 'if_lte', value: 0, then: null },
            { op: 'divide', by: 1000 },
          ],
        },
      ],
    },
  ],
})
const products = version.nodes[1] as MappingVersion['nodes'][number]

describe('conditions', () => {
  it.each([
    [{ path: 'locationtype', eq: 'Warehouse' }],
    [{ is_null: true }],
    [{ path: 'a', is_blank: false }],
    [
      {
        all: {
          of: [
            { path: 'a', gt: 1 },
            { path: 'b', in: ['x', 'y'] },
          ],
        },
      },
    ],
    [{ any: { of: [{ path: 'a', neq: { ref: 'b' } }, { after: 'today+10y' }] } }],
  ])('round-trips %j through the rows', (cond) => {
    const parsed = parseCondition(cond)
    expect(parsed).not.toBeNull()
    expect(serializeCondition(parsed!.mode, parsed!.rows)).toEqual(cond)
  })

  it('leaves conditions the rows cannot show to JSON', () => {
    expect(parseCondition({ not: { eq: 1 } })).toBeNull()
    expect(parseCondition({ all: { of: [{ any: { of: [] } }] } })).toBeNull()
  })

  it('treats a missing or empty condition as no rows', () => {
    expect(parseCondition(undefined)).toEqual({ mode: 'all', rows: [] })
    expect(serializeCondition('all', [])).toEqual({})
  })
})

describe('steps', () => {
  it('shows sugar as the when it expands to', () => {
    const steps = asSteps([{ op: 'if_lte', value: 0, then: null }])
    expect(steps).toEqual([{ op: 'when', cases: [{ cond: { lte: 0 }, then: null }] }])
    expect(stepSummary(steps[0]!)).toEqual({ label: 'When', detail: '≤ 0 → empty' })
  })

  it('summarises reads and units', () => {
    expect(stepSummary({ op: 'extract', path: ['weight', 'weightunit'] })).toEqual({
      label: 'Read field',
      detail: 'weight + weightunit',
    })
    expect(stepSummary({ op: 'convert_unit', to: 'g' }).detail).toBe('to g')
  })
})

describe('inspector card', () => {
  it('edits with controls, switches to JSON, and applies valid JSON', () => {
    const onChange = vi.fn()
    render(
      wrap(
        <InspectorOverlay
          version={version}
          node={products}
          issues={[]}
          right={8}
          onChange={onChange}
          onClose={() => {}}
        />,
      ),
    )
    expect(screen.getByDisplayValue('sku')).toBeTruthy()
    expect(screen.getByDisplayValue('width')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'JSON' }))
    const editor = screen.getByLabelText('Settings as JSON') as HTMLTextAreaElement
    expect(JSON.parse(editor.value).fields).toHaveLength(2)
    // The input reference is drawn on the canvas, not edited as JSON.
    expect(JSON.parse(editor.value).in).toBeUndefined()

    fireEvent.change(editor, { target: { value: '{ "fields": [' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/Not applied/)).toBeTruthy()

    fireEvent.change(editor, { target: { value: '{ "fields": [], "keep": "all" }' } })
    const next = onChange.mock.calls.at(-1)?.[0] as MappingVersion
    expect(next.nodes[1]).toMatchObject({ id: 'products', in: 'items', keep: 'all', fields: [] })
  })

  it('renames a field from its card', () => {
    const onChange = vi.fn()
    render(
      wrap(
        <InspectorOverlay
          version={version}
          node={products}
          issues={[]}
          right={8}
          onChange={onChange}
          onClose={() => {}}
        />,
      ),
    )
    fireEvent.change(screen.getByDisplayValue('sku'), { target: { value: 'product.sku' } })
    const next = onChange.mock.calls.at(-1)?.[0] as MappingVersion
    const fields = (next.nodes[1]?.fields ?? []) as { key: string }[]
    expect(fields[0]?.key).toBe('product.sku')
  })

  it('plays its exit before unmounting', () => {
    const props = { version, issues: [], right: 8, onChange: () => {}, onClose: () => {} }
    const { container, rerender } = render(wrap(<InspectorOverlay {...props} node={products} />))
    rerender(wrap(<InspectorOverlay {...props} node={null} />))
    const card = container.querySelector('.insp-card') as HTMLElement
    expect(card.classList.contains('is-closing')).toBe(true)
    act(() => {
      // jsdom has no AnimationEvent, so React listens for the prefixed name there.
      fireEvent.animationEnd(card)
      fireEvent(card, new Event('webkitAnimationEnd', { bubbles: true }))
    })
    expect(container.querySelector('.insp-card')).toBeNull()
  })

  it('has a form for every node op', async () => {
    const { FORMS } = await import('./forms')
    const { nodeCatalog } = await import('@hockeymask/core')
    expect(Object.keys(FORMS).sort()).toEqual(nodeCatalog.map((e) => e.op).sort())
    expect(emptyVersion('x').nodes).toEqual([])
  })
})
