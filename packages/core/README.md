# @hockeymask/core

**Different schemas. Same story.**

Typed transformation graphs for mapping one data model onto another. A mapping is a
versioned JSON document: a DAG of collection nodes (`source`, `filter`, `map`, `join`,
`aggregate`, `distinct`, `union`, `sink`, ...) whose `map` nodes run small per-field
pipelines (`extract`, `trim`, `to_number`, `convert_unit`, `when`, ...).

The engine is pure. Your connectors read the sources, the engine compiles and checks the
mapping against your target schema, runs it over a frozen snapshot, and returns the rows each
sink would write. Writing them is up to you.

```sh
npm install @hockeymask/core
```

## Example

```ts
import { compileVersion, execute, parseVersion, type TargetSchema } from '@hockeymask/core'

const targets: TargetSchema = {
  name: 'shop',
  entities: [
    {
      name: 'product',
      description: null,
      identity: ['sku'],
      fields: [
        {
          name: 'sku',
          logicalType: 'string',
          nullable: false,
          description: null,
          unit: null,
          references: null,
        },
        {
          name: 'title',
          logicalType: 'string',
          nullable: true,
          description: null,
          unit: null,
          references: null,
        },
        {
          name: 'weight_g',
          logicalType: 'decimal',
          nullable: true,
          description: null,
          unit: null,
          references: null,
        },
      ],
    },
  ],
}

const version = parseVersion({
  id: 'items-to-products',
  expectedSchema: {
    items: {
      type: 'object',
      properties: {
        itemid: { type: 'string' },
        displayname: { type: ['string', 'null'] },
        weight_kg: { type: ['number', 'null'] },
      },
      required: ['itemid', 'displayname', 'weight_kg'],
    },
  },
  nodes: [
    { id: 'items', op: 'source', system: 'erp', entity: 'item' },
    {
      id: 'products',
      op: 'map',
      in: 'items',
      fields: [
        { key: 'product.sku', pipeline: [{ op: 'extract', path: 'itemid' }] },
        {
          key: 'product.title',
          pipeline: [
            { op: 'extract', path: 'displayname' },
            { op: 'trim' },
            { op: 'blank_to_null' },
          ],
        },
        {
          key: 'product.weight_g',
          pipeline: [
            { op: 'extract', path: 'weight_kg' },
            { op: 'multiply', by: 1000 },
          ],
        },
      ],
    },
    { id: 'out', op: 'sink', in: 'products', target: 'product', key: ['product.sku'] },
  ],
})

const compiled = compileVersion(version, { targets })
if (!compiled.ok) throw new Error(compiled.issues.map((i) => i.message).join('\n'))

const result = execute(
  compiled.plan,
  { items: [{ itemid: 'A-1', displayname: '  Product A ', weight_kg: 2 }] },
  { now: '2026-10-24T12:00:00Z' },
)
// result.sinks[0].write.rows:
// [{ 'product.sku': 'A-1', 'product.title': 'Product A', 'product.weight_g': 2000 }]
```

## What is in the package

- **Schema**: `Table`, `Column`, `Row`, `TargetSchema` (zod schemas with inferred types).
- **Connector**: the `Connector` contract a source fulfils (`listTables`, `describe`, `sample`,
  `read`, `query`), plus `ConnectorError` and `SourceUnavailable`.
- **Mapping**: `parseVersion`, `compileVersion`, `readSnapshot`, `execute`, the node and
  operator registry, expectations and examples (fixtures checked at compile time).

See the [architecture](https://github.com/mono424/hockeymask/blob/main/arch.md) and the
[operators reference](https://github.com/mono424/hockeymask/blob/main/docs/operators.md).

## License

MIT
