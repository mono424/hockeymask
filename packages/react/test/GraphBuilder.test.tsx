import { addNode, emptyVersion } from '@hockeymask/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, expect, it, vi } from 'vite-plus/test'
import { GraphBuilder, NodePalette } from '../src'

beforeAll(() => {
  // React Flow measures the DOM; jsdom has no layout engine.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1
  } as unknown as typeof DOMMatrixReadOnly
})

it('renders the version and adds a node from the palette', () => {
  const version = addNode(emptyVersion('g'), 'source', {
    id: 'items',
    label: 'NetSuite item',
  }).version
  const onChange = vi.fn()
  render(
    <div style={{ width: 800, height: 600 }}>
      <NodePalette value={version} onChange={onChange} />
      <GraphBuilder value={version} onChange={onChange} />
    </div>,
  )
  expect(screen.getByText('NetSuite item')).toBeTruthy()
  expect(screen.getByText('Checks')).toBeTruthy()

  screen.getByRole('button', { name: /Join/ }).click()
  const added = onChange.mock.calls[0]?.[0]
  expect(added.nodes.map((n: { op: string }) => n.op)).toEqual(['source', 'join'])
  expect(added.layout[added.nodes[1].id]).toBeDefined()
})

it('switches the selection to a node earlier in the document', () => {
  let version = addNode(emptyVersion('g'), 'source', { id: 'a' }).version
  version = addNode(version, 'source', { id: 'b' }).version
  const onSelectNode = vi.fn()
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <GraphBuilder
        value={version}
        onChange={vi.fn()}
        selectedNodeId="b"
        onSelectNode={onSelectNode}
      />
    </div>,
  )
  fireEvent.click(container.querySelector('.react-flow__node[data-id="a"]') as Element)
  // React Flow reports "select a" before "deselect b"; the click must still select a.
  expect(onSelectNode.mock.calls.at(-1)).toEqual(['a'])
})

it('moves a node without selecting it', () => {
  const version = addNode(emptyVersion('g'), 'source', { id: 'a' }).version
  const onChange = vi.fn()
  const onSelectNode = vi.fn()
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <GraphBuilder value={version} onChange={onChange} onSelectNode={onSelectNode} />
    </div>,
  )
  const node = container.querySelector('.react-flow__node[data-id="a"]') as Element
  const mouse = (target: Element | Window, type: string, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: x })
    // d3-drag follows the pointer on `event.view`, which jsdom won't take in the init dict.
    Object.defineProperty(event, 'view', { value: window })
    fireEvent(target, event)
  }
  mouse(node, 'mousedown', 10)
  mouse(window, 'mousemove', 60)
  mouse(window, 'mouseup', 60)
  mouse(node, 'click', 60)
  expect(onChange).toHaveBeenCalled()
  expect(onSelectNode).not.toHaveBeenCalledWith('a')
})
