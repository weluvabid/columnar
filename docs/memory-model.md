# Memory model

## Column buffers

| Logical type                               | Physical representation                                   |
| ------------------------------------------ | --------------------------------------------------------- |
| Signed/unsigned integer and floating point | Native typed array                                        |
| Numeric JavaScript array                   | `Float64Array`                                            |
| Boolean                                    | `Uint8Array`                                              |
| String                                     | `Uint32Array` dictionary indices plus a string dictionary |
| Nullability                                | Optional bit-packed `Uint32Array`                         |

Validity bit `i` lives in word `i >>> 5`, at bit position `i & 31`. A set bit means the value is present. Columns without nulls don't need a bitmap. Unused bits at the end of a bitmap must be zero.

## Buffer lifetime

Typed-array inputs are retained by reference. Columnar doesn't clone their backing buffers during ingestion. The caller and table therefore share memory, and writes through either reference are visible through the other.

Queries read the input buffers during execution. Keep shared input buffers stable while a query is running.

## Allocation boundaries

- `Table.fromColumns` retains typed-array buffers.
- `Table.fromRows` allocates typed column buffers and converts row values once. Type inference and validity detection share the ingestion pass.
- `select` creates a new table/schema view and reuses selected column objects.
- `filter().execute()` samples the first 1,024 rows, sizes a row-index buffer with 12.5% headroom and grows it geometrically when needed. Output columns are compact. A selection allocates an output validity bitmap only when the selected rows include nulls.
- `aggregateStream` reuses aggregate-plan objects across chunks and refreshes chunk-local typed-array references and predicate bindings.
- `aggregate().execute()` allocates aggregate state and result fields, not intermediate tables.
- `aggregateStream` retains aggregate state and the current producer-supplied chunk.

The producer controls streaming chunk sizes. The engine processes each chunk before requesting the next one.
