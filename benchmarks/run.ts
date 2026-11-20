import { performance } from 'node:perf_hooks';
import { col, sum, table } from '../src/index.js';

interface BenchmarkResult {
  readonly name: string;
  readonly milliseconds: number;
  readonly heapDeltaBytes: number;
  readonly arrayBufferDeltaBytes: number;
  readonly result: number;
}

const DEFAULT_SIZES = [100_000, 1_000_000];
const LARGE_SIZES = [10_000_000];
const sizes = process.argv.includes('--large') ? [...DEFAULT_SIZES, ...LARGE_SIZES] : DEFAULT_SIZES;

for (const size of sizes) {
  console.log(`\nDataset: ${size.toLocaleString()} rows`);

  const values = new Float64Array(size);

  for (let index = 0; index < size; index += 1) {
    values[index] = (index * 17) % 1_000;
  }

  const source = table({ value: values });
  const threshold = 500;
  const expected = nativeFused(values, threshold);
  const records = size <= 1_000_000 ? Array.from(values, (value) => ({ value })) : undefined;

  const results = [
    await benchmark('Columnar fused filter + sum', () => {
      const result = source
        .query()
        .filter(col('value').gt(threshold))
        .aggregate({ total: sum('value') })
        .execute();

      return result['total'] ?? 0;
    }),
    await benchmark('Native typed-array fused loop', () => nativeFused(values, threshold)),
    await benchmark('Native typed-array filter + reduce', () => {
      const selected = Array.from(values).filter((value) => value > threshold);

      return selected.reduce((total, value) => total + value, 0);
    }),
  ];

  if (records !== undefined) {
    results.push(
      await benchmark('Native object filter + reduce', () => {
        const selected = records.filter((record) => record.value > threshold);

        return selected.reduce((total, record) => total + record.value, 0);
      }),
    );
  }

  for (const result of results) {
    if (!approximatelyEqual(result.result, expected)) {
      throw new Error(`${result.name} returned ${result.result}; expected ${expected}.`);
    }

    console.log(
      `${result.name.padEnd(38)} ${result.milliseconds.toFixed(2).padStart(9)} ms  ` +
        `heap Δ ${formatBytes(result.heapDeltaBytes).padStart(10)}  ` +
        `buffers Δ ${formatBytes(result.arrayBufferDeltaBytes).padStart(10)}`,
    );
  }

  const columnar = results[0];
  const native = results[1];
  const materialized = results[2];

  if (columnar !== undefined && native !== undefined && materialized !== undefined) {
    console.log(
      `Columnar / native fused: ${(native.milliseconds / columnar.milliseconds).toFixed(2)}x`,
    );
    const materializedSpeedup = (materialized.milliseconds / columnar.milliseconds).toFixed(2);

    console.log(`Columnar / native materialized: ${materializedSpeedup}x`);
  }
}

async function benchmark(name: string, operation: () => number): Promise<BenchmarkResult> {
  for (let warmup = 0; warmup < 3; warmup += 1) {
    operation();
  }

  const durations: number[] = [];
  let result = 0;
  let heapDeltaBytes = 0;
  let arrayBufferDeltaBytes = 0;

  for (let iteration = 0; iteration < 7; iteration += 1) {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;

    forceGc?.();

    const before = process.memoryUsage();
    const startedAt = performance.now();

    result = operation();
    durations.push(performance.now() - startedAt);
    const after = process.memoryUsage();

    heapDeltaBytes += after.heapUsed - before.heapUsed;
    arrayBufferDeltaBytes += after.arrayBuffers - before.arrayBuffers;
  }

  durations.sort((left, right) => left - right);

  return {
    name,
    milliseconds: durations[Math.floor(durations.length / 2)] ?? 0,
    heapDeltaBytes: Math.round(heapDeltaBytes / durations.length),
    arrayBufferDeltaBytes: Math.round(arrayBufferDeltaBytes / durations.length),
    result,
  };
}

function nativeFused(values: Float64Array, threshold: number): number {
  let total = 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;

    if (value > threshold) {
      total += value;
    }
  }

  return total;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1, Math.abs(right)) * Number.EPSILON * 8;
}

function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : '';
  const absolute = Math.abs(bytes);

  if (absolute < 1_024) {
    return `${sign}${absolute.toFixed(0)} B`;
  }

  if (absolute < 1_048_576) {
    return `${sign}${(absolute / 1_024).toFixed(2)} KiB`;
  }

  return `${sign}${(absolute / 1_048_576).toFixed(2)} MiB`;
}
