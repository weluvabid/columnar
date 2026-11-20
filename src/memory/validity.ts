const BITS_PER_WORD = 32;

export function createValidityBitmap(values: readonly unknown[]): Uint32Array | undefined {
  let hasNulls = false;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === null || value === undefined) {
      hasNulls = true;
      break;
    }
  }

  if (!hasNulls) {
    return undefined;
  }

  const bitmap = new Uint32Array(Math.ceil(values.length / BITS_PER_WORD));

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value !== null && value !== undefined) {
      bitmap[index >>> 5] = (bitmap[index >>> 5] ?? 0) | (1 << (index & 31));
    }
  }

  return bitmap;
}

export function isValid(bitmap: Uint32Array | undefined, index: number): boolean {
  if (bitmap === undefined) {
    return true;
  }

  return ((bitmap[index >>> 5] ?? 0) & (1 << (index & 31))) !== 0;
}

export function countNulls(bitmap: Uint32Array | undefined, length: number): number {
  if (bitmap === undefined) {
    return 0;
  }

  let validCount = 0;

  for (let wordIndex = 0; wordIndex < bitmap.length; wordIndex += 1) {
    let word = bitmap[wordIndex] ?? 0;

    while (word !== 0) {
      word &= word - 1;
      validCount += 1;
    }
  }

  return length - validCount;
}
