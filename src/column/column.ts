import { SchemaError } from '../core/errors.js';
import type { ColumnInput, NumericArray, Scalar } from '../core/types.js';
import { countNulls, isValid, setValidPrefix } from '../memory/validity.js';

export type ColumnKind =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'float32'
  | 'float64'
  | 'boolean'
  | 'dictionary';

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

    if (validity !== undefined && validity.length !== Math.ceil(values.length / 32)) {
      throw new SchemaError('Validity bitmap length does not match the numeric column length.');
    }
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
    const Constructor = this.values.constructor as new (length: number) => NumericArray;
    const values = new Constructor(length);
    let validity: Uint32Array | undefined;

    for (let target = 0; target < length; target += 1) {
      const source = indices[target] as number;

      if (source >= this.length) {
        throw new RangeError(`Column index ${source} is outside [0, ${this.length}).`);
      }

      if (
        this.validity !== undefined &&
        ((this.validity[source >>> 5] as number) & (1 << (source & 31))) === 0
      ) {
        if (validity === undefined) {
          validity = new Uint32Array(Math.ceil(length / 32));

          setValidPrefix(validity, target);
        }

        continue;
      }

      values[target] = this.values[source] as number;

      if (validity !== undefined) {
        (validity[target >>> 5] as number) |= 1 << (target & 31);
      }
    }

    return new NumericColumn(values, validity);
  }

  override takeUnchecked(indices: Uint32Array, length: number): NumericColumn {
    const Constructor = this.values.constructor as new (length: number) => NumericArray;
    const values = new Constructor(length);
    let validity: Uint32Array | undefined;

    for (let target = 0; target < length; target += 1) {
      const source = indices[target] as number;

      if (
        this.validity !== undefined &&
        ((this.validity[source >>> 5] as number) & (1 << (source & 31))) === 0
      ) {
        if (validity === undefined) {
          validity = new Uint32Array(Math.ceil(length / 32));

          setValidPrefix(validity, target);
        }

        continue;
      }

      values[target] = this.values[source] as number;

      if (validity !== undefined) {
        (validity[target >>> 5] as number) |= 1 << (target & 31);
      }
    }

    return new NumericColumn(values, validity);
  }

  getNullCount(): number {
    return countNulls(this.validity, this.length);
  }
}

export class BooleanColumn extends Column {
  readonly kind = 'boolean' as const;
  readonly length: number;
  readonly values: Uint8Array;
  readonly validity: Uint32Array | undefined;

  constructor(values: Uint8Array, validity?: Uint32Array) {
    super();

    this.values = values;
    this.length = values.length;
    this.validity = validity;

    if (validity !== undefined && validity.length !== Math.ceil(values.length / 32)) {
      throw new SchemaError('Validity bitmap length does not match the boolean column length.');
    }
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
    const values = new Uint8Array(length);
    let validity: Uint32Array | undefined;

    for (let target = 0; target < length; target += 1) {
      const source = indices[target] as number;

      if (source >= this.length) {
        throw new RangeError(`Column index ${source} is outside [0, ${this.length}).`);
      }

      if (
        this.validity !== undefined &&
        ((this.validity[source >>> 5] as number) & (1 << (source & 31))) === 0
      ) {
        if (validity === undefined) {
          validity = new Uint32Array(Math.ceil(length / 32));

          setValidPrefix(validity, target);
        }

        continue;
      }

      values[target] = this.values[source] as number;

      if (validity !== undefined) {
        (validity[target >>> 5] as number) |= 1 << (target & 31);
      }
    }

    return new BooleanColumn(values, validity);
  }

  override takeUnchecked(indices: Uint32Array, length: number): BooleanColumn {
    const values = new Uint8Array(length);
    let validity: Uint32Array | undefined;

    for (let target = 0; target < length; target += 1) {
      const source = indices[target] as number;

      if (
        this.validity !== undefined &&
        ((this.validity[source >>> 5] as number) & (1 << (source & 31))) === 0
      ) {
        if (validity === undefined) {
          validity = new Uint32Array(Math.ceil(length / 32));

          setValidPrefix(validity, target);
        }

        continue;
      }

      values[target] = this.values[source] as number;

      if (validity !== undefined) {
        (validity[target >>> 5] as number) |= 1 << (target & 31);
      }
    }

    return new BooleanColumn(values, validity);
  }

  getNullCount(): number {
    return countNulls(this.validity, this.length);
  }
}

export class DictionaryColumn extends Column {
  readonly kind = 'dictionary' as const;
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

    if (validity !== undefined && validity.length !== Math.ceil(indices.length / 32)) {
      throw new SchemaError('Validity bitmap length does not match the dictionary column length.');
    }
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
    const values = new Uint32Array(length);
    let validity: Uint32Array | undefined;

    for (let target = 0; target < length; target += 1) {
      const source = indices[target] as number;

      if (source >= this.length) {
        throw new RangeError(`Column index ${source} is outside [0, ${this.length}).`);
      }

      if (
        this.validity !== undefined &&
        ((this.validity[source >>> 5] as number) & (1 << (source & 31))) === 0
      ) {
        if (validity === undefined) {
          validity = new Uint32Array(Math.ceil(length / 32));

          setValidPrefix(validity, target);
        }

        continue;
      }

      values[target] = this.indices[source] as number;

      if (validity !== undefined) {
        (validity[target >>> 5] as number) |= 1 << (target & 31);
      }
    }

    return new DictionaryColumn(values, this.dictionary, validity);
  }

  override takeUnchecked(indices: Uint32Array, length: number): DictionaryColumn {
    const values = new Uint32Array(length);
    let validity: Uint32Array | undefined;

    for (let target = 0; target < length; target += 1) {
      const source = indices[target] as number;

      if (
        this.validity !== undefined &&
        ((this.validity[source >>> 5] as number) & (1 << (source & 31))) === 0
      ) {
        if (validity === undefined) {
          validity = new Uint32Array(Math.ceil(length / 32));

          setValidPrefix(validity, target);
        }

        continue;
      }

      values[target] = this.indices[source] as number;

      if (validity !== undefined) {
        (validity[target >>> 5] as number) |= 1 << (target & 31);
      }
    }

    return new DictionaryColumn(values, this.dictionary, validity);
  }

  getNullCount(): number {
    return countNulls(this.validity, this.length);
  }
}

export function createColumn(input: ColumnInput): Column {
  if (ArrayBuffer.isView(input)) {
    if (input instanceof DataView) {
      throw new SchemaError('DataView is not a supported column input.');
    }

    if (input instanceof BigInt64Array || input instanceof BigUint64Array) {
      throw new SchemaError('BigInt typed arrays are not supported.');
    }

    if (
      input instanceof Int8Array ||
      input instanceof Uint8Array ||
      input instanceof Int16Array ||
      input instanceof Uint16Array ||
      input instanceof Int32Array ||
      input instanceof Uint32Array ||
      input instanceof Float32Array ||
      input instanceof Float64Array
    ) {
      return new NumericColumn(input as NumericArray);
    }

    throw new SchemaError('Unsupported typed-array column input.');
  }

  const values = input as readonly (number | string | boolean | null | undefined)[];
  let kind: 'number' | 'string' | 'boolean' | undefined;
  let validity: Uint32Array | undefined;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === null || value === undefined) {
      if (validity === undefined) {
        validity = new Uint32Array(Math.ceil(values.length / 32));

        setValidPrefix(validity, index);
      }

      continue;
    }

    if (validity !== undefined) {
      (validity[index >>> 5] as number) |= 1 << (index & 31);
    }

    const nextKind = typeof value;

    if (nextKind !== 'number' && nextKind !== 'string' && nextKind !== 'boolean') {
      throw new SchemaError(`Unsupported column value: ${String(value)}.`);
    }

    if (kind !== undefined && kind !== nextKind) {
      throw new SchemaError(`Mixed column types are not supported (${kind} and ${nextKind}).`);
    }

    kind = nextKind;
  }

  if (kind === 'string') {
    const dictionary: string[] = [];
    const dictionaryMap = new Map<string, number>();
    const indices = new Uint32Array(values.length);

    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];

      if (typeof value !== 'string') {
        continue;
      }

      let dictionaryIndex = dictionaryMap.get(value);

      if (dictionaryIndex === undefined) {
        dictionaryIndex = dictionary.length;
        dictionaryMap.set(value, dictionaryIndex);
        dictionary.push(value);
      }

      indices[index] = dictionaryIndex;
    }

    return new DictionaryColumn(indices, dictionary, validity);
  }

  if (kind === 'boolean') {
    const data = new Uint8Array(values.length);

    for (let index = 0; index < values.length; index += 1) {
      data[index] = values[index] === true ? 1 : 0;
    }

    return new BooleanColumn(data, validity);
  }

  const data = new Float64Array(values.length);

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value !== null && value !== undefined) {
      if (typeof value !== 'number') {
        throw new SchemaError(`Expected a number at row ${index}.`);
      }

      data[index] = value;
    }
  }

  return new NumericColumn(data, validity);
}

function getNumericKind(values: NumericArray): ColumnKind {
  if (values instanceof Int8Array) {
    return 'int8';
  }

  if (values instanceof Uint8Array) {
    return 'uint8';
  }

  if (values instanceof Int16Array) {
    return 'int16';
  }

  if (values instanceof Uint16Array) {
    return 'uint16';
  }

  if (values instanceof Int32Array) {
    return 'int32';
  }

  if (values instanceof Uint32Array) {
    return 'uint32';
  }

  if (values instanceof Float32Array) {
    return 'float32';
  }

  return 'float64';
}
