# Execution model

## Predicates

`col(name)` creates an immutable expression node. Expressions compose through `and`, `or`, and `not`. Before execution, the engine resolves each referenced column and compiles the expression tree into a row predicate.

Null comparisons follow SQL-like filtering semantics: `eq`, `ne`, and ordered comparisons involving null return false. `isNull` and `isNotNull` are explicit.

## Aggregation

An aggregate query resolves its input columns before the row loop. For each row:

1. Check the abort signal.
2. Evaluate the compiled predicates.
3. Skip rows that do not match.
4. Read each aggregate input directly from its column buffer.
5. Update its accumulator.

Each aggregate uses a specialized update path. Neumaier compensation is used for summation; mean and variance use online algorithms.

## Streaming

`aggregateStream` repeats the same bound-column and predicate process for each incoming chunk while retaining aggregate state between chunks. It uses `for await...of`, so the next chunk is requested only after the current chunk has been consumed.

## Output

`AggregateQuery.execute()` returns a plain object with numeric or null results. `QueryBuilder.execute()` returns a `Table`. `Table.toRows()` explicitly materializes row objects for interoperability; it is not used by the execution engine.
