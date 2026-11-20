import { describe, expect, it } from 'vitest';
import { col, count, max, mean, min, sum, table, variance } from '../src/index.js';

describe('query execution', () => {
  const source = table([
    { speed: 120, rpm: 3000, mode: 'sport' },
    { speed: 80, rpm: 2000, mode: 'eco' },
    { speed: 140, rpm: 4500, mode: 'sport' },
    { speed: null, rpm: 2500, mode: 'eco' },
  ]);

  it('filters and projects without changing row order', () => {
    const result = source
      .query()
      .filter(col('speed').gt(100).and(col('rpm').lt(4000)))
      .select('speed', 'mode')
      .execute();

    expect(result.toRows()).toEqual([{ speed: 120, mode: 'sport' }]);
  });

  it('filters on unprojected columns and materializes only the requested projection', () => {
    const result = table({
      id: [10, 20, 30, 40],
      score: [1, 5, 3, 8],
      mode: ['eco', 'sport', 'eco', 'sport'],
    })
      .query()
      .filter(col('score').gte(5))
      .select('id', 'mode')
      .execute();

    expect(result.columnNames).toEqual(['id', 'mode']);
    expect(result.toRows()).toEqual([
      { id: 20, mode: 'sport' },
      { id: 40, mode: 'sport' },
    ]);
  });

  it('preserves the projected schema when a filter selects no rows', () => {
    const result = table({ id: [1, 2], score: [10, 20] })
      .query()
      .filter(col('score').gt(100))
      .select('id')
      .execute();

    expect(result.rowCount).toBe(0);
    expect(result.columnNames).toEqual(['id']);
    expect(result.column('id').length).toBe(0);
  });

  it('grows sparse selection buffers when later rows are denser than the sample', () => {
    const values = new Float64Array(10_000);

    values.fill(1, 1_024);

    const result = table({ value: values }).query().filter(col('value').eq(1)).execute();

    const selectedRows = result.toRows();

    expect(result.rowCount).toBe(8_976);
    expect(selectedRows[0]).toEqual({ value: 1 });
    expect(selectedRows[8_975]).toEqual({ value: 1 });
  });

  it('preserves nulls and row order for dense selections', () => {
    const size = 10_000;
    const ids = new Int32Array(size);
    const scores = new Float64Array(size);
    const labels = new Array<string | null>(size);

    for (let index = 0; index < size; index += 1) {
      ids[index] = index;
      scores[index] = index;
      labels[index] = index % 7 === 0 ? null : `label-${index % 3}`;
    }

    const result = table({
      ids,
      scores,
      labels,
      c3: ids,
      c4: ids,
      c5: ids,
      c6: ids,
      c7: ids,
    })
      .query()
      .filter(col('ids').gte(1_000))
      .select('ids', 'labels')
      .execute();

    expect(result.rowCount).toBe(9_000);
    expect(result.columnNames).toEqual(['ids', 'labels']);
    expect(result.toRows()[0]).toEqual({ ids: 1_000, labels: 'label-1' });
    expect(result.toRows()[8]).toEqual({ ids: 1_008, labels: null });
    expect(result.toRows()[8_999]).toEqual({ ids: 9_999, labels: 'label-0' });
  });

  it('uses sampled selectivity to size sparse selection buffers', () => {
    const values = new Float64Array(10_000);

    for (let index = 0; index < values.length; index += 100) {
      values[index] = 1;
    }

    const result = table({ value: values }).query().filter(col('value').eq(1)).execute();

    const selectedRows = result.toRows();

    expect(result.rowCount).toBe(100);
    expect(selectedRows[0]).toEqual({ value: 1 });
    expect(selectedRows[99]).toEqual({ value: 1 });
  });

  it('composes OR, NOT, equality and null predicates', () => {
    const result = source
      .query()
      .filter(col('mode').eq('eco').or(col('speed').isNull()).not())
      .execute();

    expect(result.rowCount).toBe(2);
  });

  it('validates aggregate inputs against an explicit projection', () => {
    expect(() =>
      source
        .query()
        .select('speed')
        .aggregate({ average: mean('rpm') }),
    ).toThrow(/references unselected column 'rpm'/);
  });

  it('fuses filtering and aggregation into a single table traversal', () => {
    const result = source
      .query()
      .filter(col('speed').gte(100))
      .aggregate({
        total: sum('speed'),
        average: mean('speed'),
        minimum: min('speed'),
        maximum: max('speed'),
        rows: count(),
        present: count('speed'),
        spread: variance('speed'),
      })
      .execute();

    expect(result).toEqual({
      total: 260,
      average: 130,
      minimum: 120,
      maximum: 140,
      rows: 2,
      present: 2,
      spread: 100,
    });
  });

  it('shares one numeric column read across multiple aggregate states', () => {
    const values = table({
      metric: [1, 2, 3, 4, 5, null],
      weight: [10, 20, 30, 40, 50, 60],
    });

    expect(
      values
        .query()
        .filter(col('weight').gte(20))
        .aggregate({
          total: sum('metric'),
          average: mean('metric'),
          minimum: min('metric'),
          maximum: max('metric'),
          spread: variance('metric'),
          weightTotal: sum('weight'),
          weightAverage: mean('weight'),
          present: count('metric'),
          rows: count(),
        })
        .execute(),
    ).toEqual({
      total: 14,
      average: 3.5,
      minimum: 2,
      maximum: 5,
      spread: 1.25,
      weightTotal: 200,
      weightAverage: 40,
      present: 4,
      rows: 5,
    });
  });

  it('uses flattened numeric predicates with correct comparison and null semantics', () => {
    const values = table({
      first: [1, 2, 3, 4, null],
      second: [10, 20, 30, 40, 50],
    });

    expect(
      values
        .query()
        .filter(col('first').gt(1).and(col('first').lte(4)).and(col('second').ne(30)))
        .aggregate({ total: sum('first') })
        .execute(),
    ).toEqual({ total: 6 });

    expect(
      values
        .query()
        .filter(col('first').isNull())
        .aggregate({ total: sum('second') })
        .execute(),
    ).toEqual({ total: 50 });

    expect(
      values
        .query()
        .filter(col('first').isNotNull())
        .aggregate({ total: sum('first') })
        .execute(),
    ).toEqual({ total: 10 });
  });

  it('returns empty identities for null equality in multi-aggregate execution', () => {
    const result = table({ value: [1, 2, null] })
      .query()
      .filter(col('value').eq(null))
      .aggregate({ total: sum('value'), rows: count(), present: count('value') })
      .execute();

    expect(result).toEqual({ total: null, rows: 0, present: 0 });
  });

  it('preserves JavaScript comparison semantics for NaN predicates', () => {
    const values = table({ value: [Number.NaN, 1, 3] });

    expect(
      values
        .query()
        .filter(col('value').gt(1))
        .aggregate({ total: sum('value') })
        .execute(),
    ).toEqual({ total: 3 });
  });

  it('preserves low-order terms during large-magnitude cancellation', () => {
    const values = new Float64Array([1e16, 1, -1e16]);
    const singleAggregate = table({ value: values })
      .query()
      .aggregate({ total: sum('value') })
      .execute();
    const fusedAggregates = table({ value: values })
      .query()
      .aggregate({ total: sum('value'), rows: count() })
      .execute();

    expect(singleAggregate['total']).toBe(1);
    expect(fusedAggregates['total']).toBe(1);
  });

  it('uses population variance by default and supports sample variance', () => {
    const result = table([{ value: 1 }, { value: 2 }, { value: 3 }])
      .query()
      .aggregate({ population: variance('value'), sample: variance('value', true) })
      .execute();

    expect(result['population']).toBeCloseTo(2 / 3);
    expect(result['sample']).toBe(1);
  });

  it('returns null for empty numeric aggregates and zero for count', () => {
    const result = table([{ value: null }])
      .query()
      .aggregate({
        total: sum('value'),
        average: mean('value'),
        rows: count(),
        present: count('value'),
      })
      .execute();

    expect(result).toEqual({ total: null, average: null, rows: 1, present: 0 });
  });

  it('compares dictionary values through encoded indices without changing null semantics', () => {
    const modes = table({ mode: ['eco', null, 'sport'] });

    expect(
      modes.query().filter(col('mode').ne('missing')).aggregate({ rows: count() }).execute(),
    ).toEqual({ rows: 2 });
    expect(
      modes.query().filter(col('mode').eq('missing')).aggregate({ rows: count() }).execute(),
    ).toEqual({ rows: 0 });
  });

  it('supports dictionary and boolean columns in count', () => {
    const result = table([
      { mode: 'eco', active: true },
      { mode: null, active: false },
    ])
      .query()
      .aggregate({ modes: count('mode'), active: count('active') })
      .execute();

    expect(result).toEqual({ modes: 1, active: 2 });
  });

  it('rejects numeric aggregation over dictionary columns', () => {
    expect(() =>
      table([{ mode: 'eco' }])
        .query()
        .aggregate({ total: sum('mode') })
        .execute(),
    ).toThrow(/requires a numeric column/);
  });

  it('checks abort signals during execution', () => {
    const controller = new AbortController();

    controller.abort();

    expect(() =>
      source.query().aggregate({ rows: count() }, { signal: controller.signal }).execute(),
    ).toThrow(/aborted/);
  });
});
