# Execution model

## Predicates

`col(name)` creates an immutable expression node. Expressions compose through `and`, `or` and `not`. Before execution, the engine resolves referenced columns and compiles the expression into a row predicate.

Consecutive `and` nodes containing numeric comparisons and null checks can be flattened into a compact plan. The plan stores operator opcodes in a `Uint8Array`, comparison operands in a `Float64Array` and references to the bound column buffers. `or` and `not` use the general compiled-predicate path, preserving their grouping and short-circuit behaviour.

Dictionary equality predicates resolve their string operand to a dictionary index once, then compare encoded indices during row traversal. Boolean predicates read their byte representation directly. Null predicates inspect validity bits without decoding values.

Comparisons involving null return false. Use `isNull` and `isNotNull` to test missing values explicitly.

## Aggregation

An aggregate query resolves input columns and compiles aggregate kinds to numeric opcodes before the row loop. A single numeric aggregate uses a dedicated execution path without the generic aggregate-state map or per-row aggregate dispatch. The common numeric `sum` plus single `>` predicate path has a direct loop over the bound buffers.

Multiple aggregates share one row traversal. Aggregates over the same numeric column share the column-buffer and validity read for each qualifying row before updating their independent states. Numeric `and` predicates use the compiled opcode plan in multi-aggregate execution too. Count operations inspect validity metadata directly and do not decode dictionary strings or boolean values.

`sum` uses Neumaier compensation. `mean` and `variance` use online algorithms, so aggregation doesn't need a second pass over the input.

Abort signals are checked before execution and periodically during long synchronous loops.

## Streaming

`aggregateStream` rebinds chunk-local column buffers and predicates for each incoming chunk while retaining aggregate state and aggregate-plan objects between chunks. Aggregates over the same column share a read within each chunk. It uses `for await...of`, so the next chunk is requested only after the current chunk has been consumed.

## Selection

Filtered queries sample the first 1,024 rows to estimate selectivity, allocate a compact row-index buffer with 12.5% headroom, then grow geometrically if the sample underestimates later matches. This keeps the index buffer smaller for sparse results. The advanced benchmark reports the capacity and timing against a full-index reference.

## Output

`AggregateQuery.execute()` returns a plain object with numeric or null results. `QueryBuilder.execute()` returns a `Table`. `Table.toRows()` materializes row objects for interoperability; query execution works directly with the column buffers.
