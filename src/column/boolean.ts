import { ColumnKindIntent } from '../core/intents.js';
import { copySelection } from '../memory/selection.js';
import { countNulls, isValid, validateValidityBitmap } from '../memory/validity.js';
import { Column } from './base.js';

export class BooleanColumn extends Column {
  readonly kind = ColumnKindIntent.Boolean;
  readonly length: number;
  readonly values: Uint8Array;
  readonly validity: Uint32Array | undefined;

  constructor(values: Uint8Array, validity?: Uint32Array) {
    super();

    this.values = values;
    this.length = values.length;
    this.validity = validity;

    validateValidityBitmap(validity, values.length, ColumnKindIntent.Boolean);
  }

  override get(index: number): boolean | null {
    this.assertIndex(index);

    return this.getUnchecked(index);
  }

  getUnchecked(index: number): boolean | null {
    if (!isValid(this.validity, index)) {
      return null;
    }

    return (this.values[index] ?? 0) !== 0;
  }

  take(indices: Uint32Array): BooleanColumn {
    return this.takeValidated(indices, indices.length);
  }

  override takeValidated(indices: Uint32Array, length: number): BooleanColumn {
    const copied = copySelection(this.values, this.validity, this.length, indices, length, true);

    return new BooleanColumn(copied.values, copied.validity);
  }

  override takeUnchecked(indices: Uint32Array, length: number): BooleanColumn {
    const copied = copySelection(this.values, this.validity, this.length, indices, length, false);

    return new BooleanColumn(copied.values, copied.validity);
  }

  getNullCount(): number {
    return countNulls(this.validity, this.length);
  }
}
