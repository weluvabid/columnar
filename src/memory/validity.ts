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
