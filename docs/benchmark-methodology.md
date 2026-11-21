# Benchmark methodology

Run `pnpm bench` for 100K and 1M rows. Add `--large` to include 10M rows.

The benchmark compares three equivalent filter-and-sum workloads:

1. Columnar fused predicate and aggregation.
2. A native JavaScript loop over the same `Float64Array`.
3. A JavaScript `Array.from(...).filter(...).reduce(...)` pipeline that materializes intermediate arrays.
4. For datasets up to 1M rows, an object-array `filter(...).reduce(...)` pipeline.

Each case runs three warmups and seven measured iterations. The median duration is reported. The runner checks that all three implementations return equivalent results before printing comparisons.

The heap and ArrayBuffer deltas are sampled around each operation and averaged. They are runtime memory observations, not a complete allocation profiler. The runner uses `node --expose-gc` to request a collection before each sample.

## Advanced execution benchmarks

Run `pnpm bench:advanced` to measure selection/projection selectivity, multi-aggregate execution, and streaming chunk-size sensitivity. This benchmark uses a 1M-row dataset and reports medians after two warmups and five measured iterations.

Selection scenarios vary selectivity (1%, 10%, 50%, 90%) and projected width (1, 4, 8 columns). The adaptive query path is compared with a full-capacity row-index reference to expose the memory-versus-throughput trade-off. On the latest reported run, adaptive selection was 1.11–2.31x slower, but its estimated index capacity ranged from about 12.1K entries at 1% selectivity, 120.9K at 10%, 575.7K at 50%, and 1M at 90%, versus a fixed 1M-entry reference. The adaptive path remains because the sparse-case reduction in transient index memory is substantial. A separate bitmap materialization experiment was not retained in production because index-based copying was faster in most tested combinations. The opcode section compares byte-wide operator storage with a 3-bit packed experiment. Multi-aggregate execution compares one fused query with seven independent aggregate scans. Streaming uses preconstructed chunks to isolate aggregation and chunk-processing overhead for chunk sizes from 1K to 256K rows.

These are diagnostic microbenchmarks. Run them on the target machine, preserve the raw output, and compare repeated runs; do not combine their timings with the primary filter-and-sum benchmark.
