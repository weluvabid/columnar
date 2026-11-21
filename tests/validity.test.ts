import { describe, expect, it } from 'vitest';
import { NumericColumn } from '../src/column/column.js';
import { SchemaError } from '../src/core/errors.js';
import { countNulls } from '../src/memory/validity.js';

describe('validity bitmaps', () => {
  it('counts valid bits across full and partial words', () => {
    const bitmap = new Uint32Array([0xffff_ffff, 0x0000_0005]);

    expect(countNulls(bitmap, 35)).toBe(1);
  });

  it('returns zero nulls when no validity bitmap is needed', () => {
    expect(countNulls(undefined, 10)).toBe(0);
  });

  it('rejects bits outside the logical column length', () => {
    expect(() => new NumericColumn(new Float64Array([1]), new Uint32Array([0b11]))).toThrow(
      SchemaError,
    );
  });

  it('accepts a correctly masked partial word', () => {
    const column = new NumericColumn(new Float64Array([1, 2, 3]), new Uint32Array([0b101]));

    expect(column.getNullCount()).toBe(1);
    expect(column.get(0)).toBe(1);
    expect(column.get(1)).toBeNull();
    expect(column.get(2)).toBe(3);
  });
});
