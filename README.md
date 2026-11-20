# Columnar

**A typed-array-native data processing engine for JavaScript and TypeScript.**

Columnar keeps tabular data in contiguous typed-array buffers, compiles predicates once per execution, and runs filtered aggregations in a fused traversal. It is designed for application workloads that need fast in-process analytics without converting every row into an intermediate object.

```ts
import { col, count, mean, sum, table } from '@columnar/core';

const vehicles = table({
  timestamp: new Float64Array([0, 10, 20, 30]),
  speed: new Float32Array([120, 80, 140, 110]),
  rpm: new Uint16Array([3_100, 2_400, 4_200, 3_600]),
});

const result = vehicles
  .query()
  .filter(col('speed').gte(100).and(col('rpm').lt(4_000)))
  .aggregate({
    observations: count(),
    totalSpeed: sum('speed'),
    averageSpeed: mean('speed'),
  })
  .execute();

console.log(result);
// { observations: 2, totalSpeed: 230, averageSpeed: 115 }
```

## What it provides

- Typed-array-backed numeric columns with zero-copy typed-array ingestion.
- Dictionary-encoded string columns.
- Bit-packed validity maps for nullable values.
- Boolean columns stored as bytes.
- Composable predicates with `and`, `or`, and `not`.
- Fused filtering and aggregation without intermediate row objects or filtered tables.
- Neumaier compensated summation, online mean, and Welford population/sample variance.
- Chunk-at-a-time asynchronous aggregation with upstream backpressure.
- ESM output and TypeScript declarations, with no runtime dependencies.

## Install

```sh
pnpm add @columnar/core
```

## Input

### Column-oriented input

Use typed arrays for the direct columnar path. Typed-array inputs are retained by reference; the table and caller share their backing buffers.

```ts
import { table } from '@columnar/core';

const dataset = table({
  timestamp: new Float64Array([0, 10, 20]),
  temperature: new Float32Array([21.5, 22.1, 21.9]),
  sample: new Uint32Array([1, 2, 3]),
});
```

### Row-oriented input

Ordinary records are accepted and converted to column storage once at ingestion.

```ts
const dataset = table([
  { city: 'Pune', temperature: 28.5, active: true },
  { city: 'Chennai', temperature: 31.2, active: false },
]);
```

Numeric arrays become `Float64Array` columns, booleans become byte columns, and strings become dictionary-encoded columns. `null` and `undefined` values are represented by a validity bitmap. A column containing only null values is represented as a nullable numeric column.

## Queries

### Filter and project

```ts
const fastVehicles = dataset
  .query()
  .filter(col('temperature').gt(25))
  .select('city', 'temperature')
  .execute();
```

`select` returns a table containing references to the selected columns. Filtering creates compact output buffers for the selected columns.

### Aggregation

```ts
import { count, max, mean, min, sum, variance } from '@columnar/core';

const summary = dataset
  .query()
  .filter(col('temperature').gte(20))
  .aggregate({
    samples: count(),
    validTemperatures: count('temperature'),
    total: sum('temperature'),
    average: mean('temperature'),
    minimum: min('temperature'),
    maximum: max('temperature'),
    populationVariance: variance('temperature'),
    sampleVariance: variance('temperature', true),
  })
  .execute();
```

Supported aggregates are `count`, `sum`, `mean`, `min`, `max`, and `variance`. Numeric aggregates skip nulls. `count()` counts rows; `count(column)` counts non-null values. Empty numeric aggregates return `null`. Variance is population variance by default; pass `true` for sample variance.

### Predicates

```ts
const predicate = col('temperature')
  .gte(20)
  .and(col('city').ne('Pune'))
  .or(col('temperature').isNull());
```

Available comparisons: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `isNull`, and `isNotNull`. Comparisons involving null evaluate to false; use the explicit null predicates to test missing values.

## Streaming aggregation

`aggregateStream` consumes an `AsyncIterable<Table>` one chunk at a time. It retains aggregate state, not prior chunks, and requests the next chunk only after processing the current one.

```ts
import { aggregateStream, count, mean, sum, table } from '@columnar/core';

async function* readBatches() {
  yield table({ temperature: new Float32Array([21.5, 27.2, 29.1]) });
  yield table({ temperature: new Float32Array([24.8, 31.4, 26.3]) });
}

const result = await aggregateStream(readBatches(), {
  rows: count(),
  total: sum('temperature'),
  average: mean('temperature'),
});
```

An optional `where` predicate filters rows per chunk, and an optional `AbortSignal` cancels processing:

```ts
const abortController = new AbortController();

const result = await aggregateStream(
  readBatches(),
  { average: mean('temperature') },
  {
    where: col('temperature').gt(25),
    signal: abortController.signal,
  },
);
```

## Memory model

| Input               | Representation                                            |
| ------------------- | --------------------------------------------------------- |
| Numeric typed array | Original typed array, retained by reference               |
| Numeric JS array    | `Float64Array`                                            |
| Boolean values      | `Uint8Array`                                              |
| Strings             | `Uint32Array` dictionary indices plus a string dictionary |
| Nullability         | Optional `Uint32Array` validity bitmap (one bit per row)  |

The direct typed-array path is zero-copy. Mutations to a caller-owned typed array are visible to the table. Do not mutate shared input buffers while a query is executing.

A fused aggregate query allocates aggregate state proportional to the number of requested aggregates. It does not allocate an intermediate result table. A filtered table query allocates a selection index buffer and compact output buffers. Streaming aggregation retains only the current input chunk and aggregate state.

## Development

Requires Node.js 26.13.0 and pnpm 12.0.0.

```sh
pnpm install
pnpm check
pnpm bench
pnpm bench -- --large
```

`pnpm check` runs type checking, ESLint, Prettier validation, tests, and the package build. The benchmark compares the fused Columnar query with a native typed-array loop and a materializing JavaScript pipeline. Run benchmarks on an otherwise idle machine using the same Node.js build for repeatable comparisons.

Each example can be opened as a StackBlitz project after `@columnar/core` is published to npm.

## License

MIT
