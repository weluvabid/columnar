import { performance } from 'node:perf_hooks';
import { aggregateStream, col, count, max, mean, min, sum, table, variance } from '../src/index.js';
import { countNulls } from '../src/memory/validity.js';

const ROWS = 1_000_000;
const ITERATIONS = 5;
const WARMUPS = 2;

console.log('\nSelection and projection');

const columns: Record<string, Float64Array> = {};

for (let columnIndex = 0; columnIndex < 8; columnIndex += 1) {
  const values = new Float64Array(ROWS);

  for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
    values[rowIndex] = rowIndex + columnIndex;
  }

  columns[`c${columnIndex}`] = values;
}

for (const density of [1, 10, 50, 90]) {
  const flag = new Uint8Array(ROWS);

  for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
    flag[rowIndex] = rowIndex % 100 < density ? 1 : 0;
  }

  const source = table({ ...columns, flag });
  const predicate = col('flag').eq(1);
  let sampledMatches = 0;

  for (let rowIndex = 0; rowIndex < 1_024; rowIndex += 1) {
    sampledMatches += flag[rowIndex] === 1 ? 1 : 0;
  }

  const estimatedCapacity = Math.min(
    ROWS,
    Math.max(1_024, Math.ceil((sampledMatches / 1_024) * ROWS * 1.125)),
  );

  console.log(
    ` ${String(density).padStart(2)}% index capacity: ` +
      `adaptive ${estimatedCapacity.toLocaleString()} ` +
      `(${((estimatedCapacity * Uint32Array.BYTES_PER_ELEMENT) / 1_024).toFixed(1)} KiB) · ` +
      `full ${ROWS.toLocaleString()} ` +
      `(${((ROWS * Uint32Array.BYTES_PER_ELEMENT) / 1_024).toFixed(1)} KiB)`,
  );

  for (const projectionCount of [1, 4, 8]) {
    const projection = Array.from({ length: projectionCount }, (_, index) => `c${index}`);
    const adaptiveResult = await measure(() => {
      const selected = source
        .query()
        .filter(predicate)
        .select(...projection)
        .execute();

      return selected.rowCount + (selected.column('c0').get(0) as number);
    });
    const indexResult = await measure(() => {
      const matches = predicate.bind(source);
      const indices = new Uint32Array(ROWS);
      let selectedCount = 0;

      for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
        if (matches(rowIndex)) {
          indices[selectedCount] = rowIndex;
          selectedCount += 1;
        }
      }

      const selected = source.takeSelectionUnchecked(indices, selectedCount, projection);

      return selected.rowCount + (selected.column('c0').get(0) as number);
    });

    console.log(
      `${String(density).padStart(2)}% selectivity · ${projectionCount} columns: ` +
        `adaptive ${adaptiveResult.toFixed(2)} ms · ` +
        `full-index ${indexResult.toFixed(2)} ms · ` +
        `adaptive/full-index ${(adaptiveResult / indexResult).toFixed(2)}x`,
    );
  }
}

console.log('\nPredicate opcode representation');

const opcodeValues = new Float64Array(ROWS);

for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
  opcodeValues[rowIndex] = rowIndex % 997;
}

const opcodeOperands = Float64Array.from([250, 750, 500, 900, 100, 400, 0, 0]);
const opcodeSequence = Uint8Array.from([2, 4, 1, 3, 5, 0, 7, 6]);

for (const opcodeCount of [1, 2, 4, 8]) {
  const operators = opcodeSequence.slice(0, opcodeCount);
  const packedOperators = packThreeBitOpcodes(operators);
  const operands = opcodeOperands.slice(0, opcodeCount);

  for (let index = 0; index < opcodeCount; index += 1) {
    if (readThreeBitOpcode(packedOperators, index) !== operators[index]) {
      throw new Error(`Packed opcode round-trip failed at index ${index}.`);
    }
  }

  const expectedMatches = countOpcodeMatches(opcodeValues, operators, operands, false);
  const packedMatches = countOpcodeMatches(opcodeValues, packedOperators, operands, true);

  if (packedMatches !== expectedMatches) {
    throw new Error(`Packed opcode mismatch for ${opcodeCount} predicates.`);
  }

  const byteDuration = await measure(() => {
    const matches = countOpcodeMatches(opcodeValues, operators, operands, false);

    if (matches !== expectedMatches) {
      throw new Error(`Byte opcode mismatch for ${opcodeCount} predicates.`);
    }

    return matches;
  });
  const packedDuration = await measure(() => {
    const matches = countOpcodeMatches(opcodeValues, packedOperators, operands, true);

    if (matches !== expectedMatches) {
      throw new Error(`Packed opcode mismatch for ${opcodeCount} predicates.`);
    }

    return matches;
  });

  console.log(
    ` ${opcodeCount} predicates: Uint8 ${byteDuration.toFixed(2)} ms · ` +
      `3-bit ${packedDuration.toFixed(2)} ms · ` +
      `${(packedDuration / byteDuration).toFixed(2)}x · ` +
      `${operators.byteLength} B vs ${packedOperators.byteLength} B`,
  );
}

console.log('\nMulti-aggregate execution');

const aggregateValues = columns['c0'] as Float64Array;
const aggregateSource = table({ value: aggregateValues, other: columns['c1'] as Float64Array });
const aggregateWhere = col('other').gt(250_000);
const aggregateSpec = {
  total: sum('value'),
  average: mean('value'),
  minimum: min('value'),
  maximum: max('value'),
  spread: variance('value'),
  present: count('value'),
  rows: count(),
};

const expectedAggregates = aggregateSource
  .query()
  .filter(aggregateWhere)
  .aggregate(aggregateSpec)
  .execute();
const independentAggregates = {
  total: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ total: sum('value') })
    .execute()['total'],
  average: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ average: mean('value') })
    .execute()['average'],
  minimum: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ minimum: min('value') })
    .execute()['minimum'],
  maximum: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ maximum: max('value') })
    .execute()['maximum'],
  spread: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ spread: variance('value') })
    .execute()['spread'],
  present: aggregateSource
    .query()
    .filter(aggregateWhere)
    .aggregate({ present: count('value') })
    .execute()['present'],
  rows: aggregateSource.query().filter(aggregateWhere).aggregate({ rows: count() }).execute()[
    'rows'
  ],
};

for (const [name, value] of Object.entries(expectedAggregates)) {
  if (independentAggregates[name as keyof typeof independentAggregates] !== value) {
    throw new Error(`Multi-aggregate mismatch for '${name}'.`);
  }
}

const fusedAggregates = await measure(
  () =>
    aggregateSource.query().filter(aggregateWhere).aggregate(aggregateSpec).execute()['total'] ?? 0,
);

const separateAggregates = await measure(() => {
  const query = aggregateSource.query().filter(aggregateWhere);

  return (
    (query.aggregate({ total: sum('value') }).execute()['total'] ?? 0) +
    (query.aggregate({ average: mean('value') }).execute()['average'] ?? 0) +
    (query.aggregate({ minimum: min('value') }).execute()['minimum'] ?? 0) +
    (query.aggregate({ maximum: max('value') }).execute()['maximum'] ?? 0) +
    (query.aggregate({ spread: variance('value') }).execute()['spread'] ?? 0) +
    (query.aggregate({ present: count('value') }).execute()['present'] ?? 0) +
    (query.aggregate({ rows: count() }).execute()['rows'] ?? 0)
  );
});

console.log(`One fused multi-aggregate query: ${fusedAggregates.toFixed(2)} ms`);
console.log(`Seven independent aggregate queries: ${separateAggregates.toFixed(2)} ms`);
console.log(`Repeated-scan advantage: ${(separateAggregates / fusedAggregates).toFixed(2)}x`);

console.log('\nStreaming chunk-size sensitivity');

for (const chunkSize of [1_024, 16_384, 65_536, 262_144]) {
  const chunks: ReturnType<typeof table>[] = [];

  for (let offset = 0; offset < ROWS; offset += chunkSize) {
    const length = Math.min(chunkSize, ROWS - offset);
    const values = new Float64Array(length);

    for (let index = 0; index < length; index += 1) {
      values[index] = (offset + index) % 1_000;
    }

    chunks.push(table({ value: values }));
  }

  const result = await measureAsync(async () => {
    const aggregate = await aggregateStream(
      (async function* () {
        yield* chunks;
      })(),
      {
        total: sum('value'),
        average: mean('value'),
        spread: variance('value'),
        rows: count(),
      },
      { where: col('value').gt(500) },
    );

    return aggregate['total'] ?? 0;
  });

  console.log(`${String(chunkSize).padStart(6)} rows/chunk: ${result.toFixed(2)} ms`);
}

console.log('\nValidity bitmap null counting');

const validityRows = 10_000_000;
const validity = new Uint32Array(Math.ceil(validityRows / 32));

for (let wordIndex = 0; wordIndex < validity.length; wordIndex += 1) {
  validity[wordIndex] = wordIndex % 7 === 0 ? 0x5555_5555 : 0xffff_ffff;
}

const remainingBits = validityRows & 31;

if (remainingBits !== 0) {
  validity[validity.length - 1] =
    (validity[validity.length - 1] as number) & ((1 << remainingBits) - 1);
}

const expectedNullCount = countNullsKernighan(validity, validityRows);

if (countNulls(validity, validityRows) !== expectedNullCount) {
  throw new Error('Validity bitmap null-count implementations disagree.');
}

const bitmapPopcountDuration = await measure(() => countNulls(validity, validityRows));
const bitClearingDuration = await measure(() => countNullsKernighan(validity, validityRows));

console.log(`SWAR popcount: ${bitmapPopcountDuration.toFixed(2)} ms`);
console.log(`Set-bit clearing: ${bitClearingDuration.toFixed(2)} ms`);

async function measure(operation: () => number): Promise<number> {
  for (let index = 0; index < WARMUPS; index += 1) {
    operation();
  }

  const durations: number[] = [];

  for (let index = 0; index < ITERATIONS; index += 1) {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;

    forceGc?.();

    const startedAt = performance.now();

    operation();
    durations.push(performance.now() - startedAt);
  }

  durations.sort((left, right) => left - right);

  return durations[Math.floor(durations.length / 2)] ?? 0;
}

async function measureAsync(operation: () => Promise<number>): Promise<number> {
  for (let index = 0; index < WARMUPS; index += 1) {
    await operation();
  }

  const durations: number[] = [];

  for (let index = 0; index < ITERATIONS; index += 1) {
    const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;

    forceGc?.();

    const startedAt = performance.now();

    await operation();
    durations.push(performance.now() - startedAt);
  }

  durations.sort((left, right) => left - right);

  return durations[Math.floor(durations.length / 2)] ?? 0;
}

function packThreeBitOpcodes(operators: Uint8Array): Uint8Array {
  const packed = new Uint8Array(Math.ceil((operators.length * 3) / 8));

  for (let index = 0; index < operators.length; index += 1) {
    const bitOffset = index * 3;
    const byteOffset = bitOffset >>> 3;
    const shift = bitOffset & 7;
    const opcode = (operators[index] as number) & 7;

    packed[byteOffset] = (packed[byteOffset] as number) | (opcode << shift);

    if (shift > 5) {
      packed[byteOffset + 1] = (packed[byteOffset + 1] as number) | (opcode >>> (8 - shift));
    }
  }

  return packed;
}

function readThreeBitOpcode(packed: Uint8Array, index: number): number {
  const bitOffset = index * 3;
  const byteOffset = bitOffset >>> 3;
  const shift = bitOffset & 7;
  let opcode = (packed[byteOffset] as number) >>> shift;

  if (shift > 5) {
    opcode |= (packed[byteOffset + 1] as number) << (8 - shift);
  }

  return opcode & 7;
}

function countOpcodeMatches(
  values: Float64Array,
  operators: Uint8Array,
  operands: Float64Array,
  packed: boolean,
): number {
  let matches = 0;

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const value = values[rowIndex] as number;
    let matchesRow = true;

    for (let operatorIndex = 0; operatorIndex < operands.length; operatorIndex += 1) {
      const opcode = packed
        ? readThreeBitOpcode(operators, operatorIndex)
        : (operators[operatorIndex] as number);
      const operand = operands[operatorIndex] as number;

      switch (opcode) {
        case 0:
          matchesRow = value === operand;
          break;
        case 1:
          matchesRow = value !== operand;
          break;
        case 2:
          matchesRow = value > operand;
          break;
        case 3:
          matchesRow = value >= operand;
          break;
        case 4:
          matchesRow = value < operand;
          break;
        case 5:
          matchesRow = value <= operand;
          break;
        case 6:
          matchesRow = false;
          break;
        case 7:
          matchesRow = true;
          break;
      }

      if (!matchesRow) {
        break;
      }
    }

    matches += matchesRow ? 1 : 0;
  }

  return matches;
}

function countNullsKernighan(bitmap: Uint32Array, length: number): number {
  let validCount = 0;

  for (let wordIndex = 0; wordIndex < bitmap.length; wordIndex += 1) {
    let word = bitmap[wordIndex] as number;

    while (word !== 0) {
      word &= word - 1;
      validCount += 1;
    }
  }

  return length - validCount;
}
