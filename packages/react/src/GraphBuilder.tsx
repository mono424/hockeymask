import {
  addNode,
  canConnect,
  type CompileIssue,
  connect,
  disconnect,
  type MappingVersion,
  moveNode,
  removeNode,
} from '@hockeymask/core'
import {
  applyNodeChanges,
  Background,
  type Connection as FlowConnection,
  ControlButton,
  Controls,
  type Edge,
  type EdgeChange,
  type FitViewOptions,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { type DragEvent, type ReactNode, useCallback, useMemo, useState } from 'react'
import {
  catalogEntry,
  type FlowNode,
  NODE_TYPE,
  NODE_TYPE_MIME,
  readNodeTemplate,
  toFlowEdges,
  toFlowNodes,
} from './adapters'
import { GraphNodeView, NodeRenderersContext, type NodeRenderers } from './GraphNodeView'
import { layoutGraph } from './layout'

const nodeTypes = { [NODE_TYPE]: GraphNodeView }

/** Three columns of boxes: the left-to-right layout this button applies. */
function LayoutIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <rect x="1.5" y="5.5" width="3" height="5" rx="1" />
      <rect x="6.5" y="2.5" width="3" height="4" rx="1" />
      <rect x="6.5" y="9.5" width="3" height="4" rx="1" />
      <rect x="11.5" y="5.5" width="3" height="5" rx="1" />
    </svg>
  )
}

export interface GraphBuilderProps extends NodeRenderers {
  /** The document being edited. The builder never mutates it; every edit goes to onChange. */
  value: MappingVersion
  onChange: (version: MappingVersion) => void
  /** Issues to show on nodes, typically `validateStructure(value)` or `checkVersion` issues. */
  issues?: readonly CompileIssue[]
  /** Controlled selection; leave undefined to let the builder track it. */
  selectedNodeId?: string | null
  onSelectNode?: (id: string | null) => void
  /** Shown on an empty canvas; nothing when omitted. */
  emptyMessage?: ReactNode
  /** React Flow colour mode; the package styles default to dark. */
  colorMode?: 'light' | 'dark' | 'system'
  /**
   * Fit-view padding (number, px/% string, or per side). Hosts that overlay panels on the
   * canvas pass e.g. `{ left: '300px', right: '40px' }` so fitted nodes stay visible.
   */
  fitViewPadding?: FitViewOptions['padding']
  className?: string
}

/** A React Flow canvas for building mapping DAGs. Connection rules come from core. */
export function GraphBuilder({ renderNodeIcon, describeNode, ...props }: GraphBuilderProps) {
  const renderers = useMemo(
    () => ({ renderNodeIcon, describeNode }),
    [renderNodeIcon, describeNode],
  )
  return (
    <ReactFlowProvider>
      <NodeRenderersContext value={renderers}>
        <Canvas {...props} />
      </NodeRenderersContext>
    </ReactFlowProvider>
  )
}

/** A React Flow connection as a core one: the target handle is the input slot. */
function toConnection(c: FlowConnection | Edge) {
  return { source: c.source, target: c.target, slot: c.targetHandle ?? '' }
}

/** What React Flow knows about a node that the document doesn't: size, and a drag in flight. */
interface Overlay {
  measured?: FlowNode['measured']
  dragging?: boolean
  position?: FlowNode['position']
}

function Canvas({
  value,
  onChange,
  issues,
  selectedNodeId,
  onSelectNode,
  colorMode = 'dark',
  fitViewPadding = 0.2,
  emptyMessage,
  className,
}: Omit<GraphBuilderProps, keyof NodeRenderers>) {
  const flow = useReactFlow()

  const [ownSelection, setOwnSelection] = useState<string | null>(null)
  const selected = selectedNodeId !== undefined ? selectedNodeId : ownSelection
  const select = useCallback(
    (id: string | null) => {
      setOwnSelection(id)
      onSelectNode?.(id)
    },
    [onSelectNode],
  )

  // Nodes are derived from the document on every render; the overlay only adds sizes and
  // the position of a node while it is being dragged (committed to the document on drop).
  const [overlay, setOverlay] = useState<ReadonlyMap<string, Overlay>>(new Map())
  const nodes = useMemo(
    () =>
      toFlowNodes(value, { issues, selectedNodeId: selected }).map((node) => {
        const extra = overlay.get(node.id)
        if (!extra) return node
        return {
          ...node,
          measured: extra.measured ?? node.measured,
          dragging: extra.dragging,
          position: extra.dragging && extra.position ? extra.position : node.position,
        }
      }),
    [value, issues, selected, overlay],
  )

  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set())
  const edges = useMemo(
    () => toFlowEdges(value, { selectedEdgeIds: selectedEdges, selectedNodeId: selected }),
    [value, selectedEdges, selected],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      // Removal goes through onDelete (one document edit for nodes and edges together).
      const next = applyNodeChanges(
        changes.filter((c) => c.type !== 'remove'),
        nodes,
      )
      setOverlay(
        new Map(
          next.map((n) => [
            n.id,
            { measured: n.measured, dragging: n.dragging, position: n.position },
          ]),
        ),
      )
      // React Flow lists select changes in node order, so "select new" can come before
      // "deselect old"; the selected node wins regardless of order.
      let picked: string | null | undefined
      for (const change of changes) {
        if (change.type !== 'select') continue
        if (change.selected) picked = change.id
        else if (change.id === selected && picked === undefined) picked = null
      }
      if (picked !== undefined) select(picked)
    },
    [nodes, select, selected],
  )

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setSelectedEdges((previous) => {
      const next = new Set(previous)
      for (const change of changes) {
        if (change.type !== 'select') continue
        if (change.selected) next.add(change.id)
        else next.delete(change.id)
      }
      return next
    })
  }, [])

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: FlowNode[]; edges: Edge[] }) => {
      let version = value
      for (const edge of cut) version = disconnect(version, toConnection(edge))
      for (const node of gone) version = removeNode(version, node.id)
      if (gone.some((n) => n.id === selected)) select(null)
      onChange(version)
    },
    [value, onChange, select, selected],
  )

  const onNodeDragStop = useCallback(
    (_: unknown, __: FlowNode, moved: FlowNode[]) => {
      let version = value
      for (const node of moved) version = moveNode(version, node.id, node.position)
      onChange(version)
    },
    [value, onChange],
  )

  const isValidConnection = useCallback(
    (c: FlowConnection | Edge) => canConnect(value, toConnection(c)).ok,
    [value],
  )

  const onConnect = useCallback(
    (c: FlowConnection) => {
      if (canConnect(value, toConnection(c)).ok) onChange(connect(value, toConnection(c)))
    },
    [value, onChange],
  )

  const onDrop = useCallback(
    (event: DragEvent) => {
      const template = readNodeTemplate(event.dataTransfer)
      if (!template || !catalogEntry(template.op)) return
      event.preventDefault()
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const { version, node } = addNode(value, template.op, {
        position,
        ...(template.params ? { params: template.params } : {}),
        ...(template.label === undefined ? {} : { label: template.label }),
      })
      onChange(version)
      select(node.id)
    },
    [flow, value, onChange, select],
  )

  const autoLayout = useCallback(() => {
    onChange(layoutGraph(value))
    requestAnimationFrame(() => void flow.fitView({ padding: fitViewPadding, duration: 200 }))
  }, [flow, value, onChange, fitViewPadding])
  return (
    <div className={['hm-builder', className].filter(Boolean).join(' ')}>
      <ReactFlow<FlowNode>
        colorMode={colorMode}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onDelete={onDelete}
        onNodeDragStop={onNodeDragStop}
        // Selecting opens the inspector; only a click should, not moving a node.
        selectNodesOnDrag={false}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onPaneClick={() => select(null)}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(NODE_TYPE_MIME)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={onDrop}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: fitViewPadding }}
        // Twice React Flow's default zoom-out range, so large graphs fit on screen.
        minZoom={0.25}
      >
        <Background gap={18} size={1.2} />
        <Controls showInteractive={false}>
          <ControlButton onClick={autoLayout} title="Auto-layout" aria-label="Auto-layout">
            <LayoutIcon />
          </ControlButton>
        </Controls>
        {value.nodes.length === 0 && emptyMessage && (
          <Panel position="top-center" className="hm-empty">
            {emptyMessage}
          </Panel>
        )}
      </ReactFlow>
    </div>
  )
}
