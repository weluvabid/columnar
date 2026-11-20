# Architecture

## Runtime path

```text
Public API
  └─ Table / QueryBuilder / AggregateQuery
       ├─ Predicate AST ── compile once ── row predicate
       └─ Aggregate specification ── bind columns once
                                      │
                                      ▼
                              Fused execution loop
                                      │
                                      ▼
                               Column buffers
```

The public API is intentionally small. `Table` owns the schema and column references. `Predicate` is an immutable expression tree. Query execution binds referenced columns before entering the row loop, avoiding repeated schema-map lookups for each value.

## Storage

- Numeric columns use the input typed array or a `Float64Array` for ordinary numeric arrays.
- Boolean columns use `Uint8Array` values.
- String columns use `Uint32Array` dictionary indices and a string dictionary.
- Nullable columns use a bit-packed `Uint32Array` validity bitmap. A column without nulls has no bitmap.

`Table.fromColumns` retains typed-array input by reference. It does not take ownership of the backing `ArrayBuffer` exclusively.

## Execution

A filtered aggregate compiles predicates and binds aggregate columns once. It then traverses the source rows once, evaluates predicates, and updates aggregate state directly. No filtered table or intermediate row objects are created.

The current physical operators are deliberately limited to filter, projection, and aggregation. The engine does not parse SQL, persist data, or execute joins.

## Numerical algorithms

- `sum`: Neumaier compensated summation.
- `mean`: online incremental mean.
- `variance`: Welford's stable one-pass algorithm, with population and sample finalization.
- `min` / `max`: one-pass comparisons.

Null values are skipped by numeric aggregates. `count()` counts qualifying rows; `count(column)` counts qualifying non-null values.

## Streaming

`aggregateStream` pulls one `Table` at a time from an `AsyncIterable`. It updates the same aggregate states before requesting the next chunk. This preserves upstream pull-based backpressure and keeps engine-owned state independent of total stream length. The producer controls the maximum size of each yielded chunk.
