# Architecture

Hockeymask maps data from connected source systems into a data model you own. A source has its
own tables, names, units and quirks; your model has its own entities, keys and types. A mapping
describes how one becomes the other, and the engine checks that description before it ever
touches data.

Most target fields are a translation of one source field: rename it, trim it, convert grams to
kilograms. Some are not. A target row can depend on several source rows (stock summed over
bins), on another entity (a product's category), or on the whole payload (only the latest
snapshot date). Hockeymask handles both with one model: a typed graph of collection
operations, with per-field pipelines inside it.

This document describes that model and the engine in
[`packages/core`](packages/core/src). The full operator reference is in
[`docs/operators.md`](docs/operators.md).

## Overview

| Part                                       | Owns                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| [`@hockeymask/core`](packages/core)        | Schema types, the `Connector` contract, the mapping document, compiler and executor. |
| [`@hockeymask/react`](packages/react)      | A visual graph builder on top of core.                                               |
| The host (your application, or `apps/api`) | Connectors, the target model, storing mappings, reading sources, writing results.    |

Core does no I/O. It never opens a connection, reads a clock or writes a row. The host
supplies a `TargetSchema` (the model sinks write to), reads the sources a plan asks for, and
receives the rows each sink would write. That keeps the engine a pure function of its inputs,
which is what makes previews, fixtures and replays trustworthy.

A connector (`listTables`, `describe`, `sample`, `read`, `query`) decodes wire formats, such as
numbers sent as strings or dates as epoch days, but never interprets values: a `'T'`/`'F'`
checkbox stays a string. Interpretation is the mapping's job, where it is visible and tested.

## Concepts

A mapping is a **directed acyclic graph of nodes over typed collections**. Data enters through
`source` nodes, flows through relational nodes such as `filter`, `join` and `aggregate`, and
leaves through `sink` nodes that produce rows for a target entity.

Per-record logic lives in `map` nodes. A `map` runs one small declarative pipeline per output
field against each record. Pipelines are built from a fixed set of typed operations (`extract`,
`when`, `divide`, `convert_unit`, `blank_to_null`, ...), not arbitrary code.

| Scope      | What flows                                    | Built from                                                                                                    |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Collection | A relation: an unordered set of typed records | `source`, `map`, `filter`, `join`, `aggregate`, `distinct`, `union`, `sink`, `metrics`, `assert`, `transform` |
| Record     | One value, inside a `map` field pipeline      | `extract`, `when`, `divide`, `convert_unit`, `lookup`, ...                                                    |

A plain field mapping is the smallest graph, `source → map → sink`. Field-level authoring looks
the same whether or not the rest of the graph exists.

Every node is a flat object `{ id, op, label?, ...params }` and names its inputs by id: `in`
for single-input nodes, `left` / `right` for `join`, `inputs` for `union` and `transform`.
Edges are implied by those references; there is no edge list. A node's output can feed any
number of later nodes, so shared work is referenced, never copied. `sink` and `metrics` are the
only nodes with effects; everything upstream is a pure function of the run's snapshot.

## Example: items to products

The sample ERP has an `item` table. Your `product` entity wants a title, a SKU, an EAN, weight
in grams, dimensions in metres, an active flag and a category reference.

```json
{
  "id": "netsuite-items-product",
  "name": "NetSuite items to products",
  "nodes": [
    { "id": "items", "op": "source", "system": "netsuite", "entity": "item" },
    {
      "id": "products",
      "op": "map",
      "in": "items",
      "fields": [
        { "key": "source_system", "pipeline": [{ "op": "const", "value": "NetSuite" }] },
        {
          "key": "source_id",
          "pipeline": [{ "op": "extract", "path": "id" }, { "op": "to_string" }]
        },
        { "key": "sku", "pipeline": [{ "op": "extract", "path": "itemid" }] },
        {
          "key": "title",
          "pipeline": [{ "op": "extract", "path": "displayname" }, { "op": "require" }]
        },
        {
          "key": "ean",
          "pipeline": [{ "op": "extract", "path": "upccode" }, { "op": "blank_to_null" }]
        },
        {
          "key": "weight",
          "pipeline": [
            { "op": "extract", "path": ["weight", "weightunit"] },
            { "op": "convert_unit", "to": "g" }
          ]
        },
        {
          "key": "length",
          "pipeline": [
            { "op": "extract", "path": "custitem_length_mm" },
            { "op": "if_lte", "value": 0, "then": null },
            { "op": "divide", "by": 1000 }
          ]
        },
        {
          "key": "active",
          "pipeline": [
            { "op": "extract", "path": "isinactive" },
            { "op": "when", "cases": [{ "cond": { "eq": "F" }, "then": true }], "else": false }
          ]
        },
        {
          "key": "launch_date",
          "pipeline": [
            { "op": "extract", "path": "custitem_launch_date" },
            { "op": "to_date", "format": "YYYY-MM-DD" }
          ]
        },
        {
          "key": "category_id",
          "pipeline": [{ "op": "extract", "path": "class" }, { "op": "to_string" }]
        }
      ]
    },
    {
      "id": "write_products",
      "op": "sink",
      "in": "products",
      "target": "product",
      "key": ["source_system", "source_id"],
      "refs": { "category_id": { "by": ["source_id"] } }
    }
  ]
}
```

`width` and `height` follow the same pattern as `length`. Things worth noticing:

- `extract` reads a field of the current record. A list of paths gives a tuple, which is how
  `convert_unit` receives both the value and its unit.
- `if_lte` is sugar for a one-case `when`. A dimension of `0` or less is garbage, not zero, so
  it becomes null before the division.
- `require` turns a missing title into a field failure instead of a null the target would
  reject. What happens to that record is the map's `on_error` policy (see
  [Failure policy](#failure-policy-and-partial-results)).
- `category_id` is a reference. The sink's `refs` says the value is a natural key of the
  referenced `category` (its `source_id`), and the host resolves it to an id when it writes.
- Each field lands on the target field of the same name. A dotted key such as `product.sku`
  names an entity explicitly, and `columns` on the sink can rename a field to another path.

## Example: stock snapshots to inventory levels

The sample warehouse table `STOCK_SNAPSHOT` holds one row per item, location, day and bin.
`inventory_level` wants one row per product and warehouse, for one date. No per-record mapping
can express that: it needs a filter over the whole table and a sum across rows.

```json
{
  "id": "snowflake-stock-inventory",
  "params": { "as_of": "2026-10-04" },
  "nodes": [
    {
      "id": "stock",
      "op": "source",
      "system": "snowflake",
      "entity": "ANALYTICS.INVENTORY.STOCK_SNAPSHOT",
      "filter": { "path": "SNAPSHOT_DATE", "eq": { "param": "as_of" } }
    },
    {
      "id": "per_location",
      "op": "aggregate",
      "in": "stock",
      "group_by": ["ITEM_ID", "LOCATION_ID", "SNAPSHOT_DATE"],
      "fields": {
        "on_hand": { "agg": "sum", "path": "ON_HAND" },
        "reserved": { "agg": "sum", "path": "RESERVED" }
      }
    },
    {
      "id": "levels",
      "op": "map",
      "in": "per_location",
      "fields": [
        {
          "key": "product_id",
          "pipeline": [{ "op": "extract", "path": "ITEM_ID" }, { "op": "to_string" }]
        },
        {
          "key": "warehouse_id",
          "pipeline": [{ "op": "extract", "path": "LOCATION_ID" }, { "op": "to_string" }]
        },
        {
          "key": "on_hand",
          "pipeline": [
            { "op": "extract", "path": "on_hand" },
            { "op": "default", "value": 0 }
          ]
        },
        { "key": "reserved", "pipeline": [{ "op": "extract", "path": "reserved" }] },
        {
          "key": "as_of",
          "pipeline": [
            { "op": "extract", "path": "SNAPSHOT_DATE" },
            { "op": "to_date", "format": "YYYY-MM-DD" }
          ]
        }
      ]
    },
    {
      "id": "write_levels",
      "op": "sink",
      "in": "levels",
      "target": "inventory_level",
      "key": ["product_id", "warehouse_id"],
      "refs": {
        "product_id": { "by": ["source_id"] },
        "warehouse_id": { "by": ["source_id"] }
      },
      "mode": "replace"
    }
  ],
  "expect": {
    "levels": {
      "count": { "min": 1000 },
      "unique": ["product_id", "warehouse_id"],
      "onFail": "stop"
    }
  }
}
```

- `as_of` is a version parameter: a named constant that can be changed without touching the
  graph.
- `sum` yields `number?` (a group of nulls sums to null). `on_hand` is required by the target,
  so the pipeline settles it with `default`; without that step the sink fails to compile.
- `mode: "replace"` makes the run the complete set of inventory levels. Because a short read
  would then delete real rows, the compiler requires a `count` expectation with a lower bound
  and a `stop` or `skip_downstream` action on the sink's input.

## The mapping document

A mapping version is one JSON document (`MappingVersion` in
[`document.ts`](packages/core/src/mapping/document.ts)); `versionJsonSchema()` exports its JSON
Schema for tools and models that produce mappings.

| Field            | Meaning                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `id`, `name`     | Identity and display name.                                                                        |
| `version`        | Version number, default 1.                                                                        |
| `status`         | `draft` or `published`.                                                                           |
| `onError`        | Default `on_error` for `map` nodes.                                                               |
| `unknownFields`  | `ignore` or `notify`; stored, not yet acted on.                                                   |
| `params`         | Named constants, referenced in predicates as `{ "param": name }`.                                 |
| `tables`         | Static value maps for the `lookup` op, e.g. `{ "Warehouse": "WAREHOUSE", "3PL": "THIRD_PARTY" }`. |
| `expectedSchema` | One JSON Schema per `source` node id, describing one record of that source.                       |
| `nodes`          | The graph.                                                                                        |
| `expect`         | Expectations about node outputs, keyed by node id.                                                |
| `examples`       | Fixtures: rows in per source, rows out per node.                                                  |
| `layout`         | Node positions for the editor. Never read by the engine.                                          |

### expectedSchema is the type environment

The type checker does not consult a live source or an external registry. It reads the
version's own `expectedSchema`. A version is therefore self-contained: it can be re-checked at
any time without access to the source system, and its assumptions about the source are as
diffable as its logic.

A starting schema comes from the connector's `describe` (`tableJsonSchema`). Sources with
`"system": "internal"` read an entity of the target model; their schema is generated from the
target model and pinned into the version when it is normalized (`entityJsonSchema`).

How a schema becomes a record type (`sourceRecordType`):

- `string`, `number` / `integer`, `boolean`, `array`, `object`, and `enum` of one scalar kind
  map to the corresponding types; anything else is `unknown`.
- A field not listed in `required`, or typed with `null` in a union or type array, is nullable.
- `{ "type": "string", "format": "date" }` is a **string**, not a date. The source really
  delivers text; `to_date` is what produces a date. Treating a format annotation as a type
  would let a pipeline skip the parse and fail at run time.

At run time every source row is checked against the declared type (`conformRows`). A value
that breaks it fails the `source` node with one issue per field, so nothing downstream runs on
data the version never claimed to handle.

### expect

Each entry applies to one node's output and is evaluated as soon as that output exists, before
any consumer runs, so an expectation can act as a firewall rather than a report.

| Clause   | Form                                                      | Catches                             |
| -------- | --------------------------------------------------------- | ----------------------------------- |
| `count`  | `{ min?, max?, shiftRatio?: { min?, max? } }`             | Join fan-out, a short or empty read |
| `unique` | `[fields]`                                                | Duplicate keys before a sink        |
| `keyed`  | `{ by, value, bounds: { key: { min?, max?, onFail? } } }` | One counter in a small relation     |
| `rows`   | `{ cond }`                                                | Rows that break a predicate         |

`count.min` / `count.max` are absolute. `shiftRatio` compares the count to a baseline the host
passes per run (`RunInput.baseline`, typically the previous run's count). The absolute
envelope catches slow drift; the ratio catches sudden jumps that stay inside the envelope.
`onFail` picks the action; see [Failure policy](#failure-policy-and-partial-results).

### examples

A fixture is relations in, keyed by source node id, and relations out, keyed by **any** node
id, so a multi-step graph is tested at the step that matters:

```json
{
  "name": "grams and garbage dimensions",
  "sources": {
    "items": [
      {
        "id": 1,
        "itemid": "AO-TENT-2P-GRN",
        "displayname": "Acme Trail Tent 2P Green",
        "upccode": "",
        "weight": 2.1,
        "weightunit": "kg",
        "custitem_length_mm": 0,
        "isinactive": "F",
        "class": 12
      }
    ]
  },
  "expect": {
    "products": [{ "sku": "AO-TENT-2P-GRN", "ean": null, "weight": 2100, "length": null }]
  }
}
```

An expected relation is compared as a set on the fields it lists: the run must produce exactly
those records, and each is matched only on the fields the fixture names. Fixture rows pass
through the same schema check as real ones, so a fixture cannot encode a shape the version
claims never to receive. A fixture also fails if its run stops or a node fails. Fixtures run at
sample size, so `count` clauses are skipped. A graph that reads the clock needs `now` (and
optionally `tz`) on the fixture.

## Structural rules

Checked on every compile, and cheap enough for the editor to run on each change
(`validateStructure`):

1. **Unique ids, known ops, resolvable references.** Every input names an existing node that
   has an output.
2. **Acyclic.** No loops, recursion or fixed points; every run terminates.
3. **No dead nodes.** Every node reaches a `sink`, `metrics` or `assert`. An unreferenced node
   is an error, not ignored.
4. **One sink per target entity.** Two branches writing one entity are combined with a `union`
   in the graph, not reconciled at write time.
5. **Every source is declared.** A `source` without an `expectedSchema` entry fails.
6. **Addressable expectations.** Every key in `expect` names a node.

`canConnect` in [`edit.ts`](packages/core/src/mapping/edit.ts) applies the same rules to a
prospective edge, so live feedback in the builder and validation on save agree.

## Type checking

Mappings are JSON, so TypeScript cannot check them. Instead, every op and node has a signature,
and the whole graph is checked from source schemas to target schema whenever a version
compiles. Nothing is type-checked per record at run time; by then the graph is a plan of
closures.

```ts
type NonNull =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'list'; of: MType }
  | { kind: 'tuple'; of: MType[] }
  | { kind: 'record'; fields: Record<string, MType> }
  | { kind: 'unit' }
  | { kind: 'unknown' }
  | { kind: 'never' }

type MType = NonNull | { kind: 'nullable'; of: NonNull }
```

Nullability is part of the type, written `number?`. `unit` is the input of a pipeline's first
step, `unknown` is a value nothing is known about, and `never` types a literal `null`
(`nullable(never)`) and the element of `[]`. A relation is deliberately not an `MType`: a field
can hold a list, never a collection, so the two scopes cannot leak into each other.

The compiler is two folds, one inside the other (see
[`compile.ts`](packages/core/src/mapping/compile.ts) and
[`pipeline.ts`](packages/core/src/mapping/pipeline.ts)):

- The **graph fold** walks nodes in topological order. Each node definition compiles itself
  from its params and its input types, returning its output record type and a closure in one
  step.
- The **pipeline fold** threads a value type and a closure through the steps of one field.

Where types come from and where they end:

- `source` nodes take their record type from `expectedSchema`.
- Every node in between derives its type from its inputs: a `left` join makes right fields
  nullable, `aggregate` types each function, `union` unifies its inputs up to nullability, a
  `filter` on `{ path, is_null: false }` narrows that field to non-null.
- `sink` nodes check each field against the target entity. An unknown path, a wrong type, or a
  nullable value for a required field fails, blamed on the `map` field that produced it.
- Join keys must be comparable, predicates are checked against the fields they name, and a
  `divide` after a string `extract` is a compile error at that step.

Issues are collected in one pass and located by node, field and step. A node whose inputs
failed is skipped silently, so one mistake does not cascade. The output types of every node
that did compile are returned too, so the editor can offer the fields reaching a node while the
graph is half built.

## Null semantics

- **Short-circuit by default.** Most ops are marked `propagate`: on a null input they do not
  run, and null flows to the end of the pipeline. The compiler implements this, so `divide` is
  written against `number`, never `number | null`, and the result type becomes `number?`.
- **Some ops consume null.** `extract`, `const`, `coalesce`, `default`, `require`,
  `omit_if_null` and `when` run on null and are where null gets handled.
- **Missing is null.** `extract` on an absent field yields null, so a field outside `required`
  is nullable.
- **Null never compares.** Equality and ordering with a null side are false, so `neq` and
  `not_in` hold for null. Null join keys never match.
- **Null versus absent.** A field set to null clears the target value; `omit_if_null` as the
  last step leaves the field out of the write instead, for PATCH-style updates.

## Failure policy and partial results

Ops are either infallible (always return a value, possibly null) or **fallible**: `require`,
strict `to_number`, `to_bool`, `to_date`, `convert_unit` with a unit read from the record,
`lookup` with `on_miss: "error"`, `fn`, and `each` over a fallible pipeline. Only a fallible
field can fail, and what happens then is the map's `on_error`:

| `on_error`              | Effect                                         |
| ----------------------- | ---------------------------------------------- |
| `skip_record` (default) | Drop the record; counted on the node.          |
| `null`                  | Write null. The field's type becomes nullable. |
| `skip_field`            | Leave the field out of the write.              |
| `fail_sync`             | Fail the node and stop the run.                |

Because `null` and `skip_field` change the field's type, a policy that would hand a required
target field a null is caught at compile time.

A record dropped inside a `map` does not just lose a field: it vanishes from every downstream
join and aggregate, and can silently change a sum or a match. So a `map` that can skip records
upstream of a `join` or `aggregate` fails to compile unless that node declares
`tolerate_skips: true`. A map built only from infallible ops cannot skip and passes.

Beyond fields:

| Where                   | Failure                        | Effect                                          |
| ----------------------- | ------------------------------ | ----------------------------------------------- |
| `source` or `transform` | Row breaks the declared schema | Node fails.                                     |
| `join`                  | Declared cardinality violated  | Node fails, with the offending key as a sample. |
| `sink`                  | Two rows share a key           | Node fails (`duplicate_key`).                   |
| Node with an `expect`   | A clause is breached           | The clause's action.                            |
| `assert`                | Check fails                    | The assert's `on_fail` action.                  |

`expect` clauses and `assert` nodes share one set of actions, and every breach is reported as
an issue whatever the action:

| Action                        | Effect                                                                                                         | Valid for        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| `alert` (default)             | Report and continue.                                                                                           | every check      |
| `drop_rows`                   | Remove the violating rows. For `unique`, every row sharing a duplicated key, so no arbitrary winner is picked. | `unique`, `rows` |
| `{ "set_null": [fields] }`    | Null those fields on violating rows.                                                                           | `rows`           |
| `{ "set_default": { f: v } }` | Set those fields to a literal on violating rows.                                                               | `rows`           |
| `skip_downstream`             | Hold back the sinks below this node; the rest proceeds.                                                        | every check      |
| `stop`                        | Hold back every sink.                                                                                          | every check      |

`onFail` takes one action, or one per clause with a `default`. Actions are checked at compile
time against the clause and the types: `set_null` widens those fields to nullable, so nulling
a field the target requires fails before any run. Repairs happen before consumers read the
node.

The graph makes the blast radius precise. "Which sinks depend on this node" is a reachability
query, so a failed node marks only its dependents `upstream_failed` while independent branches
proceed. After a `stop`, nodes that feed a `metrics` node still run: metrics describe the run
and matter most when it stops.

A run returns a status (`ok`, `partial`, or `stopped`) and, per sink, one of `write`, `held`,
`stopped`, `failed` or `upstream_failed`. Only sinks with status `write` carry rows, and only
those should be written.

## Time

A step never reads the wall clock. Each run receives a frozen `now` and an IANA time zone
(`RunInput`), and every date expression resolves against them: `"today+10y"`, `"now-1d"`, or
a literal date in `before` / `after`. Replaying a run with the same snapshot, clock and time
zone reproduces its output exactly. The compiler records whether a plan reads the clock, so a
fixture for such a graph must name its `now`.

Dates are instants at run time. `to_date` parses in the run's time zone unless given `tz`;
`shift_date` and `truncate_date` do calendar math in that zone; a sink writes a `date` target
field as `YYYY-MM-DD`.

## Execution model

1. **Compile.** `compileVersion(version, { targets })` normalizes the document (expands sugar,
   rewrites `lookup_entity` into graph nodes, pins internal schemas) and returns a `Plan` or a
   list of issues. `checkVersion` additionally runs every example; it is the gate a host calls
   before saving or publishing.
2. **Snapshot.** `readPlan(plan)` lists the sources to read. `readSnapshot(plan, read)` calls
   the host's reader once per source and freezes the result.
3. **Run.** `execute(plan, snapshot, run)` runs every node once, in topological order. Each
   edge is held only until its last consumer has run. `join` and `aggregate` are hash-based,
   and join cardinality is enforced while the hash table is built.

Results never depend on input order: sinks sort by key, `sum` adds in sorted order,
`collect_set` is sorted, and order-dependent aggregates (`collect_list`, `first`, `last`)
require `order_by`. Two runs over the same snapshot produce identical output.

Per node, the run reports rows in, rows out, records skipped, rows changed by actions, and
elapsed time, so a line such as "`stock` 9,000 → `per_location` 6,000 → `write_levels` 6,000" is
visible on the run rather than inferred.

## Sinks and write semantics

A sink compiles into a `SinkWrite` for the host: the target entity, the target paths of the
key, the rows sorted by key, and optionally `write`, `refs` and `mode`. **The library performs
no write.**

- **Identity.** Each target entity declares `identity`, the fields a re-import uses to find the
  row it wrote last time. In the demo model every imported entity carries the triple
  `(source_system, source_id, secondary_source_id)`, unique per company. A sink upserts on its
  `key`, which is usually that identity.
- **Keys** must be non-null. The exception is a nullable identity field of an entity whose
  identity matches NULLs as equal (`nullsNotDistinct`).
- **References.** `refs: { field: { by: [...] } }` types a foreign-key field as a natural key
  of the entity it points to: the type of the one `by` field, or a tuple of them in order. A
  key of the wrong shape fails at compile time; the host resolves it to an id on write.
- **Write policy.** `write: { field: "overwrite" | "fill_if_null" | "never" }` per field, so
  "only set if currently empty" is a declared policy rather than a self-join on the target.
- **Replace.** `mode: "replace"` declares that the rows are the complete set of the target
  (for the company and source), so the host deletes rows the run no longer produces. That suits
  fully derived entities such as a current stock snapshot. It requires a `count` lower bound
  with `stop` or `skip_downstream` on the sink's input, and a sink that does not write deletes
  nothing.

A host should apply all `write` sinks of one run in one transaction, inserting parents before
children and deleting children before parents.

## Versioning and drafts

The document carries `version` and `status`, and everything the version depends on lives
inside it: graph, source assumptions, expectations, parameters, lookup tables and fixtures.
Nothing about a mapping is stored anywhere else, so accepting a source change means saving a
new version, which is diffable and attributable.

How versions are stored is the host's choice. The demo keeps one current document per mapping
in Postgres (`mapping_graph`) and reports `checkVersion` issues on every save. Unsaved edits
are drafts held in the browser; the builder, the inspector and the agent panel all edit the
same draft, and nothing reaches the API until the user saves. A testbench runs the draft over
sample rows in the browser, using the same `execute`.

## Escape hatches

Some logic does not belong in a declarative op set: external API calls, iterative algorithms,
or rules that read better as code. Rather than growing an op for each, there are two explicit
hooks, both registered by the host in `GraphEnv` and referenced by name:

- `{ "op": "fn", "ref": "..." }` at record scope: a value in, a value out, with declared input
  and output types and fallibility.
- `{ "op": "transform", "ref": "...", "inputs": [...], "schema": {...} }` at collection scope:
  relations in, one relation out, with a declared output schema so the rest of the graph still
  type-checks. Its rows are checked against that schema at run time.

The `assert` node's built-in checks are the same idea shipped with the engine: `acyclic`, for
example, detects cycles in an edge relation, which a DAG of relational nodes cannot express.

## Limitations

- **One output per pipeline, linear pipelines.** A value two fields need becomes its own field
  in an upstream `map` and is referenced from there.
- **Not invertible.** `aggregate`, `distinct`, `blank_to_null`, `truncate` and `round` have no
  inverse; writing back to a source needs its own mapping.
- **In memory.** The executor holds relations in memory, freeing each edge after its last
  consumer. That is fine into the low millions of rows, not beyond.
- **Join fan-out.** A join on the wrong keys multiplies rows. Declared cardinality is enforced,
  and an `n:m` join must carry a `count` expectation or it does not compile.
- **Authoring.** Field pipelines are approachable in a form; graph shape takes more care. The
  builder, starter templates and the agent panel help, but a reviewer should still read the
  graph.
- **Contracts are types only.** `expectedSchema` is checked for type and nullability. Other
  JSON Schema keywords (`enum`, `pattern`, ranges) are stored but not enforced yet.
- **No unnest.** Child arrays in a record can be processed with list ops, but there is no node
  that turns them into rows.

## Future work

- Per-record validation of the full JSON Schema (for example with Ajv), and batch-level
  profiles such as presence rates and value distributions, so a unit change upstream is caught
  even when it type-checks.
- An `unnest` node for child arrays such as variants or line items.
- Immutable published versions with run history, so every run records the version, clock and
  snapshot it used.
- A host write path in the demo that applies `SinkWrite`s, including `replace`.
- Compiling relational subgraphs to SQL (Postgres or DuckDB) for large inputs, with `map`
  bodies staying in TypeScript. The document would not change.
