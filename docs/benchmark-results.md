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
