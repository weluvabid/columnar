import { SchemaError } from '../core/errors.js';
import { ValueKindIntent } from '../core/intents.js';
import { isNumberValue, isStringValue } from '../core/value-guards.js';
import type { ColumnInput, NumericArray } from '../core/types.js';
import { BooleanColumn, DictionaryColumn, NumericColumn, type Column } from './column.js';
import { setValidPrefix } from '../memory/validity.js';

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
  let kind: ValueKindIntent | undefined;
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

    if (
      nextKind !== ValueKindIntent.Number &&
      nextKind !== ValueKindIntent.String &&
      nextKind !== ValueKindIntent.Boolean
    ) {
      throw new SchemaError(`Unsupported column value: ${String(value)}.`);
    }

    if (kind !== undefined && kind !== nextKind) {
      throw new SchemaError(`Mixed column types are not supported (${kind} and ${nextKind}).`);
    }

    kind = nextKind;
  }

  if (kind === ValueKindIntent.String) {
    const dictionary: string[] = [];
    const dictionaryMap = new Map<string, number>();
    const indices = new Uint32Array(values.length);

    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];

      if (!isStringValue(value)) {
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

  if (kind === ValueKindIntent.Boolean) {
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
      if (!isNumberValue(value)) {
        throw new SchemaError(`Expected a number at row ${index}.`);
      }

      data[index] = value as number;
    }
  }

  return new NumericColumn(data, validity);
}
