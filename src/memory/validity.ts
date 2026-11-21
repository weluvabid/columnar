import { SchemaError } from '../core/errors.js';

export function setValidPrefix(bitmap: Uint32Array, length: number): void {
  const fullWords = length >>> 5;
  const remainingBits = length & 31;

  bitmap.fill(0xffff_ffff, 0, fullWords);

  if (remainingBits !== 0) {
    bitmap[fullWords] = (1 << remainingBits) - 1;
  }
}

export function isValid(bitmap: Uint32Array | undefined, index: number): boolean {
  if (bitmap === undefined) {
    return true;
  }

  return ((bitmap[index >>> 5] ?? 0) & (1 << (index & 31))) !== 0;
}

export function validateValidityBitmap(
  bitmap: Uint32Array | undefined,
  length: number,
  columnKind: string,
): void {
  if (bitmap === undefined) {
    return;
  }

  const expectedLength = Math.ceil(length / 32);

  if (bitmap.length !== expectedLength) {
    throw new SchemaError(`Validity bitmap length does not match the ${columnKind} column length.`);
  }

  const remainingBits = length & 31;

  if (remainingBits !== 0 && bitmap.length > 0) {
    const allowedMask = (1 << remainingBits) - 1;
    const trailingBits = (bitmap[bitmap.length - 1] as number) & ~allowedMask;

    if (trailingBits !== 0) {
      throw new SchemaError(
        `Validity bitmap for ${columnKind} column has bits set beyond its length.`,
      );
    }
  }
}

function popcount32(value: number): number {
  let bits = value - ((value >>> 1) & 0x5555_5555);

  bits = (bits & 0x3333_3333) + ((bits >>> 2) & 0x3333_3333);
  bits = (bits + (bits >>> 4)) & 0x0f0f_0f0f;

  return (Math.imul(bits, 0x0101_0101) >>> 24) & 0xff;
}

export function countNulls(bitmap: Uint32Array | undefined, length: number): number {
  if (bitmap === undefined) {
    return 0;
  }

  let validCount = 0;

  for (let wordIndex = 0; wordIndex < bitmap.length; wordIndex += 1) {
    validCount += popcount32(bitmap[wordIndex] as number);
  }

  return length - validCount;
}
