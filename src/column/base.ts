import type { Scalar } from '../core/types.js';
import type { ColumnKindIntent } from '../core/intents.js';

export type ColumnKind = ColumnKindIntent;

export abstract class Column {
  abstract readonly kind: ColumnKind;
  abstract readonly length: number;
  abstract getUnchecked(index: number): Scalar;
  abstract take(indices: Uint32Array): Column;
  /** @internal Validates and copies a selection prefix. */
  takeValidated(indices: Uint32Array, length: number): Column {
    const selection = length === indices.length ? indices : indices.subarray(0, length);

    return this.take(selection);
  }

  /** @internal Copies a previously validated selection into a compact column. */
  takeUnchecked(indices: Uint32Array, length: number): Column {
    const selection = length === indices.length ? indices : indices.subarray(0, length);

    return this.take(selection);
  }

  abstract getNullCount(): number;

  get(index: number): Scalar {
    this.assertIndex(index);

    return this.getUnchecked(index);
  }

  protected assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Column index ${index} is outside [0, ${this.length}).`);
    }
  }
}
