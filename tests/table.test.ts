import { describe, expect, it } from 'vitest';
import {
  BooleanColumn,
  DictionaryColumn,
  NumericColumn,
  SchemaError,
  Table,
  table,
} from '../src/index.js';

describe('Table', () => {
  it('builds a columnar table from rows and preserves nulls', () => {
    const result = table([
      { speed: 120, mode: 'sport', active: true },
      { speed: null, mode: 'eco', active: false },
      { speed: 80, mode: 'sport', active: null },
    ]);

    expect(result.rowCount).toBe(3);
    expect(result.columnNames).toEqual(['speed', 'mode', 'active']);
    expect(result.column('speed')).toBeInstanceOf(NumericColumn);
    expect(result.column('mode')).toBeInstanceOf(DictionaryColumn);
    expect(result.column('active')).toBeInstanceOf(BooleanColumn);
    expect(result.column('speed').getNullCount()).toBe(1);
    expect(result.toRows()).toEqual([
      { speed: 120, mode: 'sport', active: true },
      { speed: null, mode: 'eco', active: false },
      { speed: 80, mode: 'sport', active: null },
    ]);
  });

  it('constructs inferred columns directly while preserving missing and null values', () => {
    const result = Table.fromRows([
      { speed: 120, mode: 'sport', active: true },
      { speed: undefined, mode: 'eco', active: false },
      { speed: 80, mode: undefined, active: null },
      { speed: null, mode: 'sport', active: true },
    ]);

    expect(result.toRows()).toEqual([
      { speed: 120, mode: 'sport', active: true },
      { speed: null, mode: 'eco', active: false },
      { speed: 80, mode: null, active: null },
      { speed: null, mode: 'sport', active: true },
    ]);
  });

  it('infers an all-null column as numeric', () => {
    const result = Table.fromRows([{ value: null }, { value: undefined }]);

    expect(result.column('value')).toBeInstanceOf(NumericColumn);
    expect(result.toRows()).toEqual([{ value: null }, { value: null }]);
  });

  it('validates row schemas and inferred column types', () => {
    expect(() => Table.fromRows([{ value: 1 }, { value: 2, extra: true }])).toThrow(SchemaError);
    expect(() => Table.fromRows([{ value: 1 }, { value: 'two' }])).toThrow(SchemaError);
  });

  it('reads accessor-backed row values once during ingestion', () => {
    let reads = 0;
    const row: Record<string, number> = {};

    Object.defineProperty(row, 'value', {
      enumerable: true,
      get() {
        reads += 1;

        return 42;
      },
    });

    const result = Table.fromRows([row]);

    expect(reads).toBe(1);
    expect(result.toRows()).toEqual([{ value: 42 }]);
  });

  it('retains typed-array input without copying', () => {
    const values = new Float32Array([1, 2, 3]);
    const result = Table.fromColumns({ value: values });
    const column = result.column('value');

    expect(column).toBeInstanceOf(NumericColumn);
    expect((column as NumericColumn).values).toBe(values);
  });

  it('treats sparse array slots as null values', () => {
    const values = new Array<number>(3);

    values[1] = 7;
    const result = table({ value: values });

    expect(result.toRows()).toEqual([{ value: null }, { value: 7 }, { value: null }]);
  });

  it('preserves special property names as ordinary columns', () => {
    const first = { value: 1 };
    const second = { value: 2 };

    Object.defineProperty(first, '__proto__', { value: 'first', enumerable: true });
    Object.defineProperty(second, '__proto__', { value: 'second', enumerable: true });

    const result = table([first, second]);

    expect(result.columnNames).toEqual(['value', '__proto__']);
    expect(result.toRows().map((row) => row['__proto__'])).toEqual(['first', 'second']);
  });

  it('avoids allocating a validity bitmap when take selects only valid rows', () => {
    const source = table({ value: [1, null, 3] });
    const selected = source.take(new Uint32Array([0, 2]));
    const selectedColumn = selected.column('value') as NumericColumn;

    expect(selectedColumn.validity).toBeUndefined();
    expect(selected.toRows()).toEqual([{ value: 1 }, { value: 3 }]);
  });

  it('materializes only the selected prefix of a selection buffer', () => {
    const source = table({
      id: [10, 20, 30],
      mode: ['eco', 'sport', 'track'],
    });
    const selected = source.takeSelection(new Uint32Array([2, 0, 99]), 2, ['mode']);

    expect(selected.columnNames).toEqual(['mode']);
    expect(selected.toRows()).toEqual([{ mode: 'track' }, { mode: 'eco' }]);
  });

  it('validates selection indices once while materializing a table', () => {
    const source = table({ first: [1, 2], second: ['a', 'b'] });

    expect(() => source.take(new Uint32Array([0, 2]))).toThrow(RangeError);
    expect(() => source.takeSelection(new Uint32Array([0]), 2)).toThrow(RangeError);
    expect(() => source.takeSelection(new Uint32Array([0]), -1)).toThrow(RangeError);
  });

  it('rejects columns with different lengths', () => {
    expect(() => Table.fromColumns({ a: [1, 2], b: [1] })).toThrow(SchemaError);
  });

  it('rejects mixed value types', () => {
    expect(() => Table.fromColumns({ value: [1, 'two'] })).toThrow(SchemaError);
  });

  it('returns an empty table for an empty row collection', () => {
    const result = Table.fromRows([]);

    expect(result.rowCount).toBe(0);
    expect(result.columnNames).toEqual([]);
  });

  it('validates public column indices', () => {
    const result = Table.fromColumns({ value: [1, 2] });

    expect(() => result.column('value').get(-1)).toThrow(RangeError);
    expect(() => result.column('value').get(2)).toThrow(RangeError);
  });
});
