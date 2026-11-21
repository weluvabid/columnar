# Benchmark results

These are the latest results from the local runs shared for this release. The benchmark runner checks the aggregate result before reporting timings.

## Filter and sum

|       Rows | Columnar fused | Hand-written typed-array loop | Typed-array filter + reduce | Object filter + reduce |
| ---------: | -------------: | ----------------------------: | --------------------------: | ---------------------: |
|    100,000 |        0.70 ms |                       0.25 ms |                     1.98 ms |                1.23 ms |
|  1,000,000 |        3.23 ms |                       2.45 ms |                    19.13 ms |               10.47 ms |
| 10,000,000 |       29.67 ms |                      21.24 ms |                   190.91 ms |                      — |

At 10M rows, the fused Columnar query completes in 29.67 ms. The materialized typed-array pipeline takes 190.91 ms, while the hand-written loop takes 21.24 ms.

The loop is a focused implementation of this one operation. It gives the application direct control over every step, and the application owns that implementation as requirements evolve. Columnar provides a reusable query layer: predicates, null handling, aggregation and execution are expressed once and handled by the engine. The point is to give application code that higher-level option without asking every caller to write and maintain a specialised loop.

### Heap delta reported by the runner

|       Rows | Columnar fused | Hand-written typed-array loop | Typed-array filter + reduce | Object filter + reduce |
| ---------: | -------------: | ----------------------------: | --------------------------: | ---------------------: |
|    100,000 |     465.38 KiB |                         485 B |                   10.57 MiB |               1.36 MiB |
|  1,000,000 |       8.01 KiB |                         475 B |                   36.69 MiB |              13.61 MiB |
| 10,000,000 |     292.30 KiB |                         491 B |                  234.79 MiB |                      — |

The runner also reported `ArrayBuffer` delta as 0 B for each implementation in these runs.

## Advanced execution

### Selection and projection

The adaptive selection buffer estimates result size from an initial sample and grows when needed. The full-index reference allocates capacity for all one million rows.

| Selectivity | Adaptive index capacity | Full-index capacity | 1-column adaptive / full | 4-column adaptive / full | 8-column adaptive / full |
| ----------: | ----------------------: | ------------------: | -----------------------: | -----------------------: | -----------------------: |
|          1% |       12,085 (47.2 KiB) |         3,906.3 KiB |   3.25 / 1.52 ms (2.14×) |   3.24 / 1.84 ms (1.76×) |   2.77 / 2.64 ms (1.05×) |
|         10% |     120,850 (472.1 KiB) |         3,906.3 KiB |   3.10 / 2.30 ms (1.35×) |   4.05 / 2.52 ms (1.61×) |   6.40 / 4.21 ms (1.52×) |
|         50% |   575,684 (2,248.8 KiB) |         3,906.3 KiB |   3.59 / 2.53 ms (1.42×) |   5.68 / 4.90 ms (1.16×) |   8.77 / 8.00 ms (1.10×) |
|         90% | 1,000,000 (3,906.3 KiB) |         3,906.3 KiB |   4.71 / 3.37 ms (1.40×) |   8.40 / 7.46 ms (1.13×) | 13.76 / 13.03 ms (1.06×) |

The adaptive path uses substantially less index capacity for sparse selections. The full-index path has lower execution time in these scenarios. The current implementation keeps the adaptive strategy because it favours lower transient index memory when few rows match.

### Predicate opcode representation

| Predicates | `Uint8Array` | 3-bit packed | Packed / byte time |   Storage |
| ---------: | -----------: | -----------: | -----------------: | --------: |
|          1 |      3.32 ms |      2.66 ms |              0.80× | 1 B / 1 B |
|          2 |      3.32 ms |      3.99 ms |              1.20× | 2 B / 1 B |
|          4 |      4.38 ms |      5.59 ms |              1.28× | 4 B / 2 B |
|          8 |      4.26 ms |      5.58 ms |              1.31× | 8 B / 3 B |

The packed representation saves only a few bytes at these predicate counts and adds decoding work to the row loop. `Uint8Array` remains the execution representation.

### Multi-aggregate execution

| Workload                              |    Median |
| ------------------------------------- | --------: |
| One fused query with seven aggregates |  13.90 ms |
| Seven independent aggregate queries   |  44.42 ms |
| Fused multi-aggregate advantage       | **3.20×** |

The fused query shares the scan and column reads across aggregate states instead of repeating the scan for each result.

### Streaming chunk-size sensitivity

| Rows per chunk |   Median |
| -------------: | -------: |
|          1,024 | 16.76 ms |
|         16,384 | 15.29 ms |
|         65,536 | 15.06 ms |
|        262,144 | 15.36 ms |

The 16K–256K results are close, with 65,536 rows per chunk narrowly ahead in this run. Chunk size remains producer-controlled.

### Validity bitmap null counting

`pnpm bench:advanced` now compares the engine's SWAR population count with the previous set-bit-clearing approach over a 10M-row validity bitmap. Run it on the target machine to capture the current timings alongside the other advanced measurements.
