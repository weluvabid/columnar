# Execution model

## Predicates

`col(name)` creates an immutable expression node. Expressions compose through `and`, `or`, and `not`. Before execution, the engine resolves referenced columns and compiles the expression tree into a row predicate.

Consecutive `and` nodes containing numeric comparisons and null checks can be flattened into a compact execution plan. The plan stores numeric operator opcodes in a `Uint8Array`, comparison operands in a `Float64Array`, and references to the bound column buffers. `or` and `not` retain the general compiled-predicate path so short-circuit and grouping semantics remain unchanged.

Dictionary equality predicates resolve their string operand to a dictionary index once, then compare encoded indices during row traversal. Boolean predicates read their byte representation directly. Null predicates inspect validity bits without decoding values.

Null comparisons follow SQL-like filtering semantics: `eq`, `ne`, and ordered comparisons involving null return false. `isNull` and `isNotNull` are explicit.

## Aggregation

An aggregate query resolves input columns and compiles aggregate kinds to numeric opcodes before the row loop. A single numeric aggregate uses a dedicated execution path without the generic aggregate-state map or per-row aggregate dispatch. The common numeric `sum` plus single `>` predicate path has a direct loop over the bound buffers.

Multiple aggregates share one row traversal. Aggregates over the same numeric column share the column-buffer and validity read for each qualifying row before updating their independent states. Numeric AND predicates use the compiled opcode plan in multi-aggregate execution too. Count operations inspect validity metadata directly and do not decode dictionary strings or boolean values. Numeric aggregation preserves Neumaier compensated summation and online mean and variance algorithms.

Abort signals are checked before execution and periodically during long synchronous loops.

## Streaming

`aggregateStream` rebinds chunk-local column buffers and predicates for each incoming chunk while retaining aggregate state and aggregate-plan objects between chunks. Aggregates over the same column share a read within each chunk. It uses `for await...of`, so the next chunk is requested only after the current chunk has been consumed.

## Selection

Filtered queries use a sampled selectivity estimate to size a compact row-index buffer, then grow geometrically if the sample underestimates later matches. This retains indirect copying for selected rows instead of scanning every source row for dense bitmaps; local comparisons found the index representation faster for most tested selectivities and projection widths.

## Output

`AggregateQuery.execute()` returns a plain object with numeric or null results. `QueryBuilder.execute()` returns a `Table`. `Table.toRows()` explicitly materializes row objects for interoperability; it is not used by the execution engine.
