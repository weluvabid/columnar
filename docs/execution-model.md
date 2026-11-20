# Execution model

## Predicates

`col(name)` creates an immutable expression node. Expressions compose through `and`, `or`, and `not`. Before execution, the engine resolves referenced columns and compiles the expression tree into a row predicate.

Consecutive `and` nodes containing numeric comparisons and null checks can be flattened into a compact execution plan. The plan stores numeric operator opcodes in a `Uint8Array`, comparison operands in a `Float64Array`, and references to the bound column buffers. `or` and `not` retain the general compiled-predicate path so short-circuit and grouping semantics remain unchanged.

Dictionary equality predicates resolve their string operand to a dictionary index once, then compare encoded indices during row traversal. Boolean predicates read their byte representation directly. Null predicates inspect validity bits without decoding values.

Null comparisons follow SQL-like filtering semantics: `eq`, `ne`, and ordered comparisons involving null return false. `isNull` and `isNotNull` are explicit.

## Aggregation

An aggregate query resolves input columns and compiles aggregate kinds to numeric opcodes before the row loop. A single numeric aggregate uses a dedicated execution path without the generic aggregate-state map or per-row aggregate dispatch. The common numeric `sum` plus single `>` predicate path has a direct loop over the bound buffers.

Multiple aggregates share one row traversal. Count operations inspect validity metadata directly and do not decode dictionary strings or boolean values. Numeric aggregation preserves Neumaier compensated summation and online mean and variance algorithms.

Abort signals are checked before execution and periodically during long synchronous loops.

## Streaming

`aggregateStream` repeats the bound-column and predicate process for each incoming chunk while retaining aggregate state between chunks. It uses `for await...of`, so the next chunk is requested only after the current chunk has been consumed.

## Output

`AggregateQuery.execute()` returns a plain object with numeric or null results. `QueryBuilder.execute()` returns a `Table`. `Table.toRows()` explicitly materializes row objects for interoperability; it is not used by the execution engine.
