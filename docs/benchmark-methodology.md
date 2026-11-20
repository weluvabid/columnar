# Benchmark methodology

Run `pnpm bench` for 100K and 1M rows. Add `--large` to include 10M rows.

The benchmark compares three equivalent filter-and-sum workloads:

1. Columnar fused predicate and aggregation.
2. A native JavaScript loop over the same `Float64Array`.
3. A JavaScript `Array.from(...).filter(...).reduce(...)` pipeline that materializes intermediate arrays.
4. For datasets up to 1M rows, an object-array `filter(...).reduce(...)` pipeline.

Each case runs three warmups and seven measured iterations. The median duration is reported. The runner checks that all three implementations return equivalent results before printing comparisons.

The heap and ArrayBuffer deltas are sampled around each operation and averaged. They are runtime memory observations, not a complete allocation profiler. The runner uses `node --expose-gc` to request a collection before each sample.

For published results, record the exact Node.js version, operating system, CPU, memory, command, dataset size, and raw output. Keep construction/ingestion timings separate from query execution timings.
