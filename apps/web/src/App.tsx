import { useState } from 'react'
import { AddIntegrationWizard } from './components/AddIntegrationWizard'
import { IconRail, type Page, PanelToggle, type View, ViewSwitch } from './components/IconRail'
import { AgentPanel, AgentRuntime } from './components/AgentPanel'
import { InputSidebar } from './components/InputSidebar'
import { IntegrationsPage } from './components/IntegrationsPage'
import { SchemaPage } from './components/SchemaPage'
import { PanelSlot } from './components/ui'
import { AGENT_INSET, PANEL_INSET, Workspace } from './components/Workspace'
import type { Integration } from './lib/integrations'
import { openMapping, select, usePersistentState, useStore } from './lib/store'

/**
 * Three pages. Integrations: a card per integration. Mappings, the editor of one integration:
 * source data and the target model on the left, the mapping in the middle, the agent on the right.
 * Schema: the target model itself, one JSON document per table.
 */
export function App() {
  const state = useStore()
  const { integrations } = state
  const [adding, setAdding] = useState(false)
  const [view, setView] = useState<View>('builder')
  const [page, setPage] = usePersistentState<Page>('hockeymask.page.v1', () => 'integrations')
  // The data model panel is opt-in; the choice sticks across reloads.
  const [panels, setPanels] = usePersistentState('hockeymask.panels.v2', () => ({
    input: true,
    agent: false,
  }))
  const { integration, graph } = openMapping(state)
  const toggle = (panel: 'input' | 'agent') => setPanels({ ...panels, [panel]: !panels[panel] })

  /** Open the integration in the editor; its input panel slides out once the editor is up. */
  const openIntegration = (next: Integration) => {
    select({ integrationId: next.id })
    setPanels({ ...panels, input: false })
    setPage('mappings')
    // Two frames: the editor paints with the panel closed, so opening it plays the slide.
    requestAnimationFrame(() => requestAnimationFrame(() => setPanels({ ...panels, input: true })))
  }

  const left = (
    <InputSidebar
      integrations={integrations}
      integration={integration}
      graphId={graph?.id}
      onClose={() => toggle('input')}
    />
  )
  const right = <AgentPanel onClose={() => toggle('agent')} />

  return (
    <AgentRuntime>
      <div className="flex h-screen p-3 pl-0">
        {/* Rail on the page background; the main content is one card, panels float inside it. */}
        <IconRail page={page} onPage={setPage} onAddIntegration={() => setAdding(true)} />
        <div className="card flex min-w-0 flex-1 overflow-hidden">
          {page === 'schema' ? (
            <SchemaPage />
          ) : page !== 'mappings' || !integration ? (
            <IntegrationsPage
              integrations={integrations}
              onOpen={openIntegration}
              onAdd={() => setAdding(true)}
            />
          ) : graph ? (
            <Workspace
              key={graph.id}
              integration={integration}
              graphRef={graph}
              view={view}
              onView={setView}
              panels={panels}
              onTogglePanel={toggle}
              left={left}
              right={right}
            />
          ) : (
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
                <PanelToggle side="input" open={panels.input} onToggle={() => toggle('input')} />
                <ViewSwitch view={view} onView={setView} disabled />
                <div className="ml-auto" />
                <PanelToggle side="agent" open={panels.agent} onToggle={() => toggle('agent')} />
              </header>
              <div className="relative min-h-0 flex-1 bg-canvas">
                <main
                  className="inset-motion absolute inset-y-0 grid place-items-center"
                  style={{
                    left: panels.input ? PANEL_INSET : 0,
                    right: panels.agent ? AGENT_INSET : 0,
                  }}
                >
                  <div className="max-w-sm px-6 text-center">
                    <p className="text-[15px] font-semibold tracking-[-0.01em]">
                      This integration has no mappings yet
                    </p>
                    <p className="mt-1.5 leading-relaxed text-muted">
                      Create one with “New mapping” in the input panel.
                    </p>
                  </div>
                </main>
                <PanelSlot side="left" open={panels.input}>
                  {left}
                </PanelSlot>
                <PanelSlot side="right" open={panels.agent}>
                  {right}
                </PanelSlot>
              </div>
            </div>
          )}
        </div>
        {adding && (
          <AddIntegrationWizard onClose={() => setAdding(false)} onCreated={openIntegration} />
        )}
      </div>
    </AgentRuntime>
  )
}
