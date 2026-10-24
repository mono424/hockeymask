/**
 * @hockeymask/react: the UI half of hockeymask.
 *
 * `GraphBuilder` edits the graph of a MappingVersion (from @hockeymask/core) on a React Flow
 * canvas; `NodePalette` lists core's node ops. Hosts can drag their own items onto the
 * canvas with `writeNodeTemplate`. Import the styles once:
 *
 *   import '@hockeymask/react/styles.css'
 */

export {
  catalogEntry,
  type FlowNode,
  type FlowNodeData,
  NODE_TYPE,
  NODE_TYPE_MIME,
  type NodeTemplate,
  OUTPUT_HANDLE,
  freePosition,
  nextPosition,
  nodeTitle,
  positionOf,
  readNodeTemplate,
  toFlowEdges,
  toFlowNodes,
  writeNodeTemplate,
} from './adapters'
export { GraphBuilder, type GraphBuilderProps } from './GraphBuilder'
export { GraphNodeView, type NodeRenderers, NodeRenderersContext } from './GraphNodeView'
export { layoutGraph, NODE_WIDTH, nodeHeight } from './layout'
export { NodePalette, type NodePaletteProps } from './NodePalette'
