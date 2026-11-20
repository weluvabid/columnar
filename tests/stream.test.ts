import { describe, expect, it } from 'vitest';
import { aggregateStream, col, count, mean, sum, table, variance } from '../src/index.js';

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

  it('preserves compensated sums across chunk boundaries', async () => {
    async function* cancellationChunks() {
      yield table({ value: new Float64Array([1e16]) });
      yield table({ value: new Float64Array([1]) });
      yield table({ value: new Float64Array([-1e16]) });
    }

    const result = await aggregateStream(cancellationChunks(), { total: sum('value') });

    expect(result['total']).toBe(1);
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
