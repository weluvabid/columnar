import { ColumnKindIntent } from '../core/intents.js';
import type { NumericArray } from '../core/types.js';
import { copySelection } from '../memory/selection.js';
import { countNulls, isValid, validateValidityBitmap } from '../memory/validity.js';
import { Column, type ColumnKind } from './base.js';

export class NumericColumn extends Column {
  readonly kind: ColumnKind;
  readonly length: number;
  readonly values: NumericArray;
  readonly validity: Uint32Array | undefined;

  constructor(values: NumericArray, validity?: Uint32Array) {
    super();

    this.values = values;
    this.length = values.length;
    this.validity = validity;
    this.kind = getNumericKind(values);

    validateValidityBitmap(validity, values.length, this.kind);
  }

  override get(index: number): number | null {
    this.assertIndex(index);

    return this.getUnchecked(index);
  }

  getUnchecked(index: number): number | null {
    if (!isValid(this.validity, index)) {
      return null;
    }

    return this.values[index] ?? 0;
  }

  take(indices: Uint32Array): NumericColumn {
    return this.takeValidated(indices, indices.length);
  }

  override takeValidated(indices: Uint32Array, length: number): NumericColumn {
    const copied = copySelection(this.values, this.validity, this.length, indices, length, true);

    return new NumericColumn(copied.values, copied.validity);
  }

  override takeUnchecked(indices: Uint32Array, length: number): NumericColumn {
    const copied = copySelection(this.values, this.validity, this.length, indices, length, false);

    return new NumericColumn(copied.values, copied.validity);
  }

  getNullCount(): number {
    return countNulls(this.validity, this.length);
  }
}

function getNumericKind(values: NumericArray): ColumnKind {
  if (values instanceof Int8Array) {
    return ColumnKindIntent.Int8;
  }

  if (values instanceof Uint8Array) {
    return ColumnKindIntent.Uint8;
  }

  if (values instanceof Int16Array) {
    return ColumnKindIntent.Int16;
  }

  if (values instanceof Uint16Array) {
    return ColumnKindIntent.Uint16;
  }

  if (values instanceof Int32Array) {
    return ColumnKindIntent.Int32;
  }

  if (values instanceof Uint32Array) {
    return ColumnKindIntent.Uint32;
  }

  if (values instanceof Float32Array) {
    return ColumnKindIntent.Float32;
  }

  return ColumnKindIntent.Float64;
}
