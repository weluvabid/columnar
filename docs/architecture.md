# Architecture

Columnar keeps the public query API small and does the repetitive execution work underneath it. A query is built from a table, predicates and an aggregate specification. Before the row loop starts, the engine resolves the referenced columns and compiles the predicate and aggregate plans.

## Runtime path

```text
Public API
  └─ Table / QueryBuilder / AggregateQuery
       ├─ Predicate AST ── compile ── bound predicate plan
       └─ Aggregate specification ── bind columns and aggregate state
                                      │
                                      ▼
                              Fused execution loop
                                      │
                                      ▼
                               Column buffers
```

`Table` owns the schema and column references. Predicate expressions are immutable. Column lookup and plan construction happen before row traversal, so the hot loop works directly with typed-array buffers.

## Source layout

- `core/` contains shared types, errors, semantic intents and execution constants.
- `column/` contains column implementations and input conversion.
- `memory/` owns validity bitmap and selection-buffer operations.
- `table/` builds tables from rows or columns and exposes table operations.
- `expressions/` defines predicate expressions and compiles them into execution plans.
- `execution/` runs queries. Aggregate expressions, shared state, single-aggregate execution and streaming execution live in separate modules.

Each module owns one part of the data path. The execution loops stay specialised where that keeps the hot path simple.

## Storage

- Numeric columns use the input typed array or a `Float64Array` for ordinary numeric arrays.
- Boolean columns use `Uint8Array` values.
- String columns use `Uint32Array` dictionary indices and a string dictionary.
- Nullable columns use a bit-packed `Uint32Array` validity bitmap. A column without nulls has no bitmap.

`Table.fromColumns` retains typed-array input by reference. The table and caller share the backing buffer.

## Execution

A filtered aggregate compiles predicates and binds aggregate columns once. It then traverses the source rows, evaluates predicates and updates aggregate state directly. It doesn't build a filtered table or intermediate row objects.

The query API currently covers filtering, projection and aggregation. These operations are designed to compose without making callers manage the underlying buffers and execution plans themselves.

## Numerical algorithms

- `sum`: Neumaier compensated summation.
- `mean`: online incremental mean.
- `variance`: Welford's one-pass algorithm, with population and sample finalization.
- `min` / `max`: one-pass comparisons.

Null values are skipped by numeric aggregates. `count()` counts qualifying rows; `count(column)` counts qualifying non-null values.

## Streaming

`aggregateStream` pulls one `Table` at a time from an `AsyncIterable`. It updates the same aggregate states before requesting the next chunk. This preserves upstream pull-based backpressure and keeps aggregate state independent of total stream length. The producer controls the size of each yielded chunk.
