import { performance } from 'node:perf_hooks';
import { aggregateStream, col, count, max, mean, min, sum, table, variance } from '../src/index.js';

const ROWS = 1_000_000;
const ITERATIONS = 5;
const WARMUPS = 2;

console.log('\nSelection and projection');

const columns: Record<string, Float64Array> = {};

for (let columnIndex = 0; columnIndex < 8; columnIndex += 1) {
  const values = new Float64Array(ROWS);

  for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
    values[rowIndex] = rowIndex + columnIndex;
  }

  columns[`c${columnIndex}`] = values;
}

for (const density of [1, 10, 50, 90]) {
  const flag = new Uint8Array(ROWS);

  for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
    flag[rowIndex] = rowIndex % 100 < density ? 1 : 0;
  }

  const source = table({ ...columns, flag });
  const predicate = col('flag').eq(1);

  for (const projectionCount of [1, 4, 8]) {
    const projection = Array.from({ length: projectionCount }, (_, index) => `c${index}`);
    const adaptiveResult = await measure(() => {
      const selected = source
        .query()
        .filter(predicate)
        .select(...projection)
        .execute();

      return selected.rowCount + (selected.column('c0').get(0) as number);
    });
    const indexResult = await measure(() => {
      const matches = predicate.bind(source);
      const indices = new Uint32Array(ROWS);
      let selectedCount = 0;

      for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
        if (matches(rowIndex)) {
          indices[selectedCount] = rowIndex;
          selectedCount += 1;
        }
      }

      const selected = source.takeSelectionUnchecked(indices, selectedCount, projection);

      return selected.rowCount + (selected.column('c0').get(0) as number);
    });

    console.log(
      `${String(density).padStart(2)}% selectivity · ${projectionCount} columns: ` +
        `adaptive ${adaptiveResult.toFixed(2)} ms · ` +
        `full-index ${indexResult.toFixed(2)} ms · ` +
        `adaptive/full-index ${(adaptiveResult / indexResult).toFixed(2)}x`,
    );
  }
}

console.log('\nMulti-aggregate execution');

const aggregateValues = columns['c0'] as Float64Array;
const aggregateSource = table({ value: aggregateValues, other: columns['c1'] as Float64Array });
const aggregateWhere = col('other').gt(250_000);
const aggregateSpec = {
  total: sum('value'),
  average: mean('value'),
  minimum: min('value'),
  maximum: max('value'),
  spread: variance('value'),
  present: count('value'),
  rows: count(),
};

const expectedAggregates = aggregateSource
  .query()
  .filter(aggregateWhere)
  .aggregate(aggregateSpec)
  .execute();
const independentAggregates = {
  total: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ total: sum('value') })
    .execute()['total'],
  average: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ average: mean('value') })
    .execute()['average'],
  minimum: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ minimum: min('value') })
    .execute()['minimum'],
  maximum: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ maximum: max('value') })
    .execute()['maximum'],
  spread: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ spread: variance('value') })
    .execute()['spread'],
  present: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ present: count('value') })
    .execute()['present'],
  rows: aggregateSource.query().filter(aggregateWhere).aggregate({ rows: count() }).execute()[
    'rows'
  ],
};

for (const [name, value] of Object.entries(expectedAggregates)) {
  if (independentAggregates[name as keyof typeof independentAggregates] !== value) {
    throw new Error(`Multi-aggregate mismatch for '${name}'.`);
  }
}

const fusedAggregates = await measure(
  () =>
    aggregateSource.query().filter(aggregateWhere).aggregate(aggregateSpec).execute()['total'] ?? 0,
);

const separateAggregates = await measure(() => {
  const query = aggregateSource.query().filter(aggregateWhere);

  return (
    (query.aggregate({ total: sum('value') }).execute()['total'] ?? 0) +
    (query.aggregate({ average: mean('value') }).execute()['average'] ?? 0) +
    (query.aggregate({ minimum: min('value') }).execute()['minimum'] ?? 0) +
    (query.aggregate({ maximum: max('value') }).execute()['maximum'] ?? 0) +
    (query.aggregate({ spread: variance('value') }).execute()['spread'] ?? 0) +
    (query.aggregate({ present: count('value') }).execute()['present'] ?? 0) +
    (query.aggregate({ rows: count() }).execute()['rows'] ?? 0)
  );
});

console.log(`One fused multi-aggregate query: ${fusedAggregates.toFixed(2)} ms`);
console.log(`Seven independent aggregate queries: ${separateAggregates.toFixed(2)} ms`);
console.log(`Repeated-scan advantage: ${(separateAggregates / fusedAggregates).toFixed(2)}x`);

console.log('\nStreaming chunk-size sensitivity');

for (const chunkSize of [1_024, 16_384, 65_536, 262_144]) {
  const chunks: ReturnType<typeof table>[] = [];

  for (let offset = 0; offset < ROWS; offset += chunkSize) {
    const length = Math.min(chunkSize, ROWS - offset);
    const values = new Float64Array(length);

    for (let index = 0; index < length; index += 1) {
      values[index] = (offset + index) % 1_000;
    }

    chunks.push(table({ value: values }));
  }

  const result = await measureAsync(async () => {
    const aggregate = await aggregateStream(
      (async function* () {
        yield* chunks;
      })(),
      {
        total: sum('value'),
        average: mean('value'),
        spread: variance('value'),
        rows: count(),
      },
      { where: col('value').gt(500) },
    );

    return aggregate['total'] ?? 0;
  });

  console.log(`${String(chunkSize).padStart(6)} rows/chunk: ${result.toFixed(2)} ms`);
}

async function measure(operation: () => number): Promise<number> {
  for (let index = 0; index < WARMUPS; index += 1) {
    operation();
  }

  const durations: number[] = [];

  for (let index = 0; index < ITERATIONS; index += 1) {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;

    forceGc?.();

    const startedAt = performance.now();

    operation();
    durations.push(performance.now() - startedAt);
  }

  durations.sort((left, right) => left - right);

  return durations[Math.floor(durations.length / 2)] ?? 0;
}

async function measureAsync(operation: () => Promise<number>): Promise<number> {
  for (let index = 0; index < WARMUPS; index += 1) {
    await operation();
  }

  const durations: number[] = [];

  for (let index = 0; index < ITERATIONS; index += 1) {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;

    forceGc?.();

    const startedAt = performance.now();

    await operation();
    durations.push(performance.now() - startedAt);
  }

  durations.sort((left, right) => left - right);

  return durations[Math.floor(durations.length / 2)] ?? 0;
}
