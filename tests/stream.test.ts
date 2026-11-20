import { describe, expect, it } from 'vitest';
import { aggregateStream, col, count, max, mean, min, sum, table, variance } from '../src/index.js';

async function* chunks() {
  yield table([{ value: 1 }, { value: 2 }, { value: null }]);
  yield table([{ value: 3 }, { value: 4 }]);
}

describe('aggregateStream', () => {
  it('aggregates incrementally across chunks', async () => {
    const result = await aggregateStream(chunks(), {
      total: sum('value'),
      average: mean('value'),
      rows: count(),
      valid: count('value'),
      variance: variance('value'),
    });

    expect(result['total']).toBe(10);
    expect(result['average']).toBe(2.5);
    expect(result['rows']).toBe(5);
    expect(result['valid']).toBe(4);
    expect(result['variance']).toBe(1.25);
  });

  it('applies a predicate independently to each incoming chunk', async () => {
    const result = await aggregateStream(
      chunks(),
      { total: sum('value'), rows: count() },
      {
        where: col('value').gt(2),
      },
    );

    expect(result).toEqual({ total: 7, rows: 2 });
  });

  it('treats null equality as an always-false streaming predicate', async () => {
    const result = await aggregateStream(
      chunks(),
      { total: sum('value'), rows: count() },
      { where: col('value').eq(null) },
    );

    expect(result).toEqual({ total: null, rows: 0 });
  });

  it('preserves compensated sums across chunk boundaries', async () => {
    async function* cancellationChunks() {
      yield table({ value: new Float64Array([1e16]) });
      yield table({ value: new Float64Array([1]) });
      yield table({ value: new Float64Array([-1e16]) });
    }

    const result = await aggregateStream(cancellationChunks(), { total: sum('value') });

    expect(result['total']).toBe(1);
  });

  it('reuses aggregate plans across many chunks without leaking chunk state', async () => {
    async function* manyChunks() {
      for (let chunkIndex = 0; chunkIndex < 128; chunkIndex += 1) {
        yield table({
          value: new Float64Array([chunkIndex, chunkIndex + 1]),
          weight: new Float64Array([1, 2]),
        });
      }
    }

    const result = await aggregateStream(
      manyChunks(),
      {
        total: sum('value'),
        average: mean('value'),
        minimum: min('value'),
        maximum: max('value'),
        weightTotal: sum('weight'),
        weightAverage: mean('weight'),
        rows: count(),
        present: count('value'),
      },
      { where: col('weight').gte(1) },
    );

    expect(result).toEqual({
      total: 16_384,
      average: 64,
      minimum: 0,
      maximum: 128,
      weightTotal: 384,
      weightAverage: 1.5,
      rows: 256,
      present: 256,
    });
  });

  it('returns empty aggregate identities for an empty stream', async () => {
    async function* empty() {}

    const result = await aggregateStream(empty(), { total: sum('value'), rows: count() });

    expect(result).toEqual({ total: null, rows: 0 });
  });

  it('honours an abort signal for an empty stream', async () => {
    async function* empty() {}

    const controller = new AbortController();

    controller.abort();

    await expect(
      aggregateStream(empty(), { rows: count() }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it('honours abort signals between chunks and rows', async () => {
    const controller = new AbortController();

    async function* abortingChunks() {
      yield table([{ value: 1 }]);
      controller.abort();
      yield table([{ value: 2 }]);
    }

    await expect(
      aggregateStream(abortingChunks(), { total: sum('value') }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });
});
