import { writeNodeTemplate } from '@hockeymask/react'
import { Box, Orbit } from 'lucide-react'
import { useState } from 'react'
import { useTargetSchema } from '../api'
import { ErrorState, FieldName, ListItem, Loading, SearchField, Section, TypeLabel } from './ui'

/** What the target model stores. Entities drag onto the canvas as target steps. */
export function ModelSection() {
  const schema = useTargetSchema()
  const [search, setSearch] = useState('')
  const term = search.trim().toLowerCase()
  return (
    <Section
      defaultOpen={false}
      title={
        <>
          <Orbit size={13} strokeWidth={1.5} className="shrink-0" />
          Target model
        </>
      }
      meta={schema.data?.entities.length}
    >
      <SearchField value={search} onChange={setSearch} placeholder="Search entities and fields" />
      {schema.isPending && <Loading />}
      {schema.isError && <ErrorState error={schema.error} />}
      <div className="flex flex-col gap-px">
        {schema.data?.entities.map((entity) => {
          const byName = !term || entity.name.toLowerCase().includes(term)
          const fields = entity.fields.filter((f) => byName || f.name.toLowerCase().includes(term))
          if (fields.length === 0) return null
          return (
            <ListItem
              key={entity.name}
              icon={<Box size={14} strokeWidth={1.5} />}
              label={<FieldName name={entity.name} />}
              meta={entity.fields.length}
              forceOpen={!byName}
              onDragStart={(event) =>
                writeNodeTemplate(event.dataTransfer, {
                  op: 'sink',
                  params: { target: entity.name },
                  label: entity.name,
                })
              }
            >
              <div className="my-0.5 ml-[15px] border-l border-line">
                {entity.description && byName && (
                  <p className="py-1.5 pr-2 pl-3 text-[12px] leading-snug text-muted">
                    {entity.description}
                  </p>
                )}
                <ul>
                  {fields.map((f) => (
                    <li
                      key={f.name}
                      title={[f.name, f.description].filter(Boolean).join(' · ')}
                      className="flex h-7 items-center gap-2 pr-2 pl-3 text-[12px]"
                    >
                      <FieldName name={f.name} />
                      <TypeLabel type={f.logicalType} unit={f.unit} />
                    </li>
                  ))}
                </ul>
              </div>
            </ListItem>
          )
        })}
      </div>
    </Section>
  )
}
