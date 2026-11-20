import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { col, sum, table } from '../src/index.js';

describe('property-based query invariants', () => {
  it('matches a reference filter and sum for arbitrary finite integer datasets', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { maxLength: 500 }),
        (values) => {
          const source = table({ value: values });
          const threshold = 17;
          const expected = values
            .filter((value) => value > threshold)
            .reduce((total, value) => total + value, 0);
          const result = source
            .query()
            .filter(col('value').gt(threshold))
            .aggregate({ total: sum('value') })
            .execute();

          expect(result['total']).toBe(values.some((value) => value > threshold) ? expected : null);
        },
      ),
      { numRuns: 200 },
    );
  });
});
