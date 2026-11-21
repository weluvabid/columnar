# Benchmark methodology

Run `pnpm bench` for 100K and 1M rows. Add `--large` to include 10M rows.

The main benchmark runs the same filter-and-sum workload through four implementations:

1. Columnar's fused predicate and aggregation.
2. A hand-written JavaScript loop over the same `Float64Array`.
3. A typed-array pipeline using `filter` and `reduce`, with an intermediate result.
4. An object-array `filter` and `reduce` pipeline for datasets up to 1M rows.

Each implementation gets three warmups and seven measured iterations. The median duration is reported, and the runner checks that the results agree before printing timings. Heap and ArrayBuffer deltas are sampled around each operation; `node --expose-gc` requests a collection before each sample.

The hand-written loop is useful as a direct, workload-specific reference. It also puts the loop, null handling, composition and maintenance of that operation in the application. Columnar gives those operations a reusable query model, so application code can describe what it needs while the engine handles the execution path.

## Advanced execution benchmarks

Run `pnpm bench:advanced` for selection/projection, predicate opcode representation, multi-aggregate execution, streaming chunk-size sensitivity and validity-bitmap null counting. The benchmark uses a 1M-row dataset for query scenarios, with a separate 10M-row bitmap for null counting. It reports medians after two warmups and five measured iterations.

Selection scenarios vary selectivity (1%, 10%, 50%, 90%) and projected width (1, 4, 8 columns). The adaptive query path is compared with a full-capacity row-index reference. The output reports both execution time and estimated index capacity, which makes the memory/throughput trade-off visible.

The opcode section compares byte-wide operator storage with a 3-bit packed experiment. Multi-aggregate execution compares one fused query with seven independent aggregate scans. Streaming uses preconstructed chunks to isolate aggregation and chunk-processing overhead for chunk sizes from 1K to 256K rows. The validity section compares the engine's SWAR population count with set-bit clearing over the same bitmap.
