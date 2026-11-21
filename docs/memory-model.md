# Memory model

## Column buffers

| Logical type                               | Physical representation                       |
| ------------------------------------------ | --------------------------------------------- |
| Signed/unsigned integer and floating point | Native typed array                            |
| Numeric JS array                           | `Float64Array`                                |
| Boolean                                    | `Uint8Array`                                  |
| String                                     | `Uint32Array` dictionary indices + dictionary |
| Nullability                                | Optional bit-packed `Uint32Array`             |

Validity bit `i` is stored in word `i >>> 5`, at bit position `i & 31`. A set bit means the value is valid. An absent bitmap means every value is valid.

## Buffer lifetime

Typed-array inputs are retained by reference. Columnar does not clone their backing buffers during ingestion. The caller and table therefore share memory, and writes through either reference are visible through the other.

Queries are synchronous and read the input buffers during execution. Callers must not mutate the same buffers concurrently with a query.

## Allocation boundaries

- `Table.fromColumns` retains typed-array buffers.
- `Table.fromRows` allocates typed column buffers and converts row values once. Column type inference and validity detection share a pass.
- `select` creates a new table/schema view and reuses selected column objects.
- `filter().execute()` samples the first 1,024 rows, sizes a row-index buffer with 12.5% headroom, and grows geometrically if necessary. This reduces transient index memory for sparse selections at some throughput cost versus a full-capacity index buffer. Output columns are compact; `take()` allocates an output validity bitmap only if the selected output actually contains nulls.
- `aggregateStream` reuses aggregate-plan objects across chunks; chunk-local typed-array references and predicate bindings are refreshed for each chunk.
- `aggregate().execute()` allocates aggregate state and result fields, not intermediate tables.
- `aggregateStream` retains aggregate state and the current producer-supplied chunk.

The streaming API does not choose chunk sizes. Bounded total memory depends on the producer yielding bounded chunks and not buffering the entire source internally.
