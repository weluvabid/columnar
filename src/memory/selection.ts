import type { NumericArray } from '../core/types.js';
import { setValidPrefix } from './validity.js';

export interface SelectionCopy<T extends NumericArray> {
  readonly values: T;
  readonly validity: Uint32Array | undefined;
}

/** Copies a selection while allocating a validity bitmap only when a null is selected. */
export function copySelection<T extends NumericArray>(
  sourceValues: T,
  sourceValidity: Uint32Array | undefined,
  sourceLength: number,
  indices: Uint32Array,
  length: number,
  validateIndices: boolean,
): SelectionCopy<T> {
  if (!Number.isInteger(length) || length < 0 || length > indices.length) {
    throw new RangeError(`Selection length ${length} is outside [0, ${indices.length}].`);
  }

  const Constructor = sourceValues.constructor as new (length: number) => T;
  const values = new Constructor(length);
  let validity: Uint32Array | undefined;

  for (let target = 0; target < length; target += 1) {
    const source = indices[target] as number;

    if (validateIndices && source >= sourceLength) {
      throw new RangeError(`Column index ${source} is outside [0, ${sourceLength}).`);
    }

    if (
      sourceValidity !== undefined &&
      ((sourceValidity[source >>> 5] as number) & (1 << (source & 31))) === 0
    ) {
      if (validity === undefined) {
        validity = new Uint32Array(Math.ceil(length / 32));
        setValidPrefix(validity, target);
      }

      continue;
    }

    values[target] = sourceValues[source] as T[number];

    if (validity !== undefined) {
      (validity[target >>> 5] as number) |= 1 << (target & 31);
    }
  }

  return { values, validity };
}
