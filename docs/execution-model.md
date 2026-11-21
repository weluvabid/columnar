# Execution model

## Predicates

`col(name)` creates an immutable expression node. Expressions compose through `and`, `or`, and `not`. Before execution, the engine resolves referenced columns and compiles the expression tree into a row predicate.

Consecutive `and` nodes containing numeric comparisons and null checks can be flattened into a compact execution plan. The plan stores numeric operator opcodes in a `Uint8Array`, comparison operands in a `Float64Array`, and references to the bound column buffers. A 3-bit packed representation was evaluated but not adopted: it saves only a handful of bytes for realistic predicate counts while adding bit extraction to the per-row hot path. In the local Node.js 22.16.0 diagnostic run, packed dispatch was 1.23–1.38x slower for 2–8 predicates. `or` and `not` retain the general compiled-predicate path so short-circuit and grouping semantics remain unchanged.

Dictionary equality predicates resolve their string operand to a dictionary index once, then compare encoded indices during row traversal. Boolean predicates read their byte representation directly. Null predicates inspect validity bits without decoding values.

Null comparisons follow SQL-like filtering semantics: `eq`, `ne`, and ordered comparisons involving null return false. `isNull` and `isNotNull` are explicit.

## Aggregation

An aggregate query resolves input columns and compiles aggregate kinds to numeric opcodes before the row loop. A single numeric aggregate uses a dedicated execution path without the generic aggregate-state map or per-row aggregate dispatch. The common numeric `sum` plus single `>` predicate path has a direct loop over the bound buffers.

Multiple aggregates share one row traversal. Aggregates over the same numeric column share the column-buffer and validity read for each qualifying row before updating their independent states. Numeric AND predicates use the compiled opcode plan in multi-aggregate execution too. Count operations inspect validity metadata directly and do not decode dictionary strings or boolean values. Numeric aggregation preserves Neumaier compensated summation and online mean and variance algorithms.

Abort signals are checked before execution and periodically during long synchronous loops.

## Streaming

`aggregateStream` rebinds chunk-local column buffers and predicates for each incoming chunk while retaining aggregate state and aggregate-plan objects between chunks. Aggregates over the same column share a read within each chunk. It uses `for await...of`, so the next chunk is requested only after the current chunk has been consumed.

## Selection

Filtered queries sample the first 1,024 rows to estimate selectivity, allocate a compact row-index buffer with 12.5% headroom, then grow geometrically if the sample underestimates later matches. This adds some execution overhead compared with a full-capacity index buffer, but substantially reduces transient index memory for sparse selections. The adaptive strategy is retained as the memory-conscious default; the advanced benchmark reports both timings and the estimated capacity trade-off.

## Output

`AggregateQuery.execute()` returns a plain object with numeric or null results. `QueryBuilder.execute()` returns a `Table`. `Table.toRows()` explicitly materializes row objects for interoperability; it is not used by the execution engine.
