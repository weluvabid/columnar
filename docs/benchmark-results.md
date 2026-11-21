# Benchmark results

The checked-in benchmark runner processes the same generated values through each implementation and verifies the aggregate result before reporting timings.

## Results

|       Rows | Columnar fused query | Native object filter + reduce | Native typed-array materialize + filter + reduce | Object-pipeline speedup | Typed-array-pipeline speedup |
| ---------: | -------------------: | ----------------------------: | -----------------------------------------------: | ----------------------: | ---------------------------: |
|  1,000,000 |              8.57 ms |                      29.67 ms |                                         73.51 ms |                   3.46× |                        8.58× |
| 10,000,000 |             84.37 ms |                             — |                                        808.16 ms |                       — |                        9.58× |

At 10M rows, the measured V8 heap delta was 6.62 KiB for the fused Columnar query and 141.59 MiB for the materializing typed-array pipeline.

## Environment

- Node.js: `v22.16.0`
- TypeScript compiler: `5.8.3`
- OS: Linux x86_64
- CPU: Intel Xeon Platinum 8573C (5 available logical CPUs)
- Runner: checked-in `benchmarks/run.ts`, compiled to ESM
- Runtime command: `node --expose-gc <compiled>/benchmarks/run.js --large`
- Method: 3 warmups, 7 measured iterations, median duration

The benchmark reports V8 heap and ArrayBuffer deltas around each operation. Re-run `pnpm bench -- --large` on the target machine to generate its local measurements.

## Advanced execution results

Latest user-reported `benchmarks/advanced.ts` run (1M rows):

### Selection and projection

| Selectivity |        1 column |       4 columns |        8 columns |
| ----------: | --------------: | --------------: | ---------------: |
|          1% | 3.89 ms (2.31x) | 3.38 ms (1.64x) |  3.42 ms (1.40x) |
|         10% | 2.57 ms (1.32x) | 4.70 ms (1.15x) |  7.52 ms (1.12x) |
|         50% | 3.62 ms (1.29x) | 6.10 ms (1.13x) |  9.53 ms (1.11x) |
|         90% | 4.08 ms (1.16x) | 9.42 ms (1.18x) | 15.56 ms (1.11x) |

Each cell is adaptive selection time; the parenthesized ratio is adaptive time divided by full-index time. Full-index was faster in all 12 cases. Adaptive selection is retained because it reduces transient index capacity for sparse selections: the benchmark's sample estimated 12,085 entries at 1%, 120,850 at 10%, 575,684 at 50%, and the full 1,000,000-entry capacity at 90%, compared with a fixed 1,000,000-entry reference.

### Multi-aggregate execution

| Workload                              |   Median |
| ------------------------------------- | -------: |
| One fused query with seven aggregates | 15.07 ms |
| Seven independent aggregate queries   | 48.38 ms |
| Fused advantage                       |    3.21x |

### Streaming chunk-size sensitivity

| Rows per chunk |   Median |
| -------------: | -------: |
|          1,024 | 17.26 ms |
|         16,384 | 16.30 ms |
|         65,536 | 15.99 ms |
|        262,144 | 15.87 ms |

The 16K–256K range differs by only 2.6%; chunk size remains producer-controlled rather than imposing a universal default.

The opcode representation experiment is included in `pnpm bench:advanced`. It compares the existing byte-wide operator array with 3-bit packing. The current diagnostic results do not justify adopting the packed representation; production continues to use `Uint8Array`.

### Predicate opcode representation experiment

A local diagnostic run under Node.js 22.16.0 compared the existing `Uint8Array` representation with 3-bit packed opcodes over 1M rows. Packed dispatch was slower in every tested case:

| Predicates | `Uint8Array` storage | 3-bit storage | Packed / byte time |
| ---------: | -------------------: | ------------: | -----------------: |
|          1 |                  1 B |           1 B |              1.08x |
|          2 |                  2 B |           1 B |              1.23x |
|          4 |                  4 B |           2 B |              1.38x |
|          8 |                  8 B |           3 B |              1.37x |

The maximum saving in this range is five bytes, so the added decode work is not justified. The production representation remains byte-wide. `pnpm bench:advanced` now includes this experiment so it can be repeated on the release target.
