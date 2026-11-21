import { SchemaError } from '../core/errors.js';
import { ColumnKindIntent } from '../core/intents.js';
import { copySelection } from '../memory/selection.js';
import { countNulls, isValid, validateValidityBitmap } from '../memory/validity.js';
import { Column } from './base.js';

export class DictionaryColumn extends Column {
  readonly kind = ColumnKindIntent.Dictionary;
  readonly length: number;
  readonly indices: Uint32Array;
  readonly dictionary: readonly string[];
  readonly validity: Uint32Array | undefined;

  constructor(indices: Uint32Array, dictionary: readonly string[], validity?: Uint32Array) {
    super();

    this.indices = indices;
    this.dictionary = dictionary;
    this.length = indices.length;
    this.validity = validity;

    validateValidityBitmap(validity, indices.length, ColumnKindIntent.Dictionary);
  }

  override get(index: number): string | null {
    this.assertIndex(index);

    return this.getUnchecked(index);
  }

  getUnchecked(index: number): string | null {
    if (!isValid(this.validity, index)) {
      return null;
    }

    const dictionaryIndex = this.indices[index] ?? 0;
    const value = this.dictionary[dictionaryIndex];

    if (value === undefined) {
      throw new SchemaError(`Dictionary index ${dictionaryIndex} is invalid.`);
    }

    return value;
  }

  take(indices: Uint32Array): DictionaryColumn {
    return this.takeValidated(indices, indices.length);
  }

  override takeValidated(indices: Uint32Array, length: number): DictionaryColumn {
    const copied = copySelection(this.indices, this.validity, this.length, indices, length, true);

    return new DictionaryColumn(copied.values, this.dictionary, copied.validity);
  }

  override takeUnchecked(indices: Uint32Array, length: number): DictionaryColumn {
    const copied = copySelection(this.indices, this.validity, this.length, indices, length, false);

    return new DictionaryColumn(copied.values, this.dictionary, copied.validity);
  }

  getNullCount(): number {
    return countNulls(this.validity, this.length);
  }
}
