import type { AggregateOptions, AggregateSpec } from './aggregate.js';
import { aggregateTable } from './aggregate.js';
import { SchemaError } from '../core/errors.js';
import type { Predicate } from '../expressions/predicate.js';
import type { Table } from '../table/table.js';

const SMALL_TABLE_SELECTION_LIMIT = 4_096;
const SELECTION_SAMPLE_SIZE = 1_024;
const SELECTION_ESTIMATE_HEADROOM = 1.125;

export class QueryBuilder {
  readonly #table: Table;
  readonly #predicates: Predicate[] = [];
  #projection: string[] | undefined;

  constructor(table: Table) {
    this.#table = table;
  }

  filter(predicate: Predicate): this {
    this.#predicates.push(predicate);

    return this;
  }

  select(...names: string[]): this {
    if (names.length === 0) {
      throw new SchemaError('Select requires at least one column.');
    }

    for (const name of names) {
      this.#table.column(name);
    }

    this.#projection = [...names];

    return this;
  }

  aggregate(spec: AggregateSpec, options: AggregateOptions = {}): AggregateQuery {
    if (this.#projection !== undefined) {
      for (const [name, expression] of Object.entries(spec)) {
        if (expression.column !== undefined && !this.#projection.includes(expression.column)) {
          throw new SchemaError(
            `Aggregate '${name}' references unselected column '${expression.column}'.`,
          );
        }
      }
    }

    return new AggregateQuery(this.#table, spec, [...this.#predicates], options);
  }

  execute(): Table {
    if (this.#predicates.length === 0) {
      return this.#projection === undefined
        ? this.#table
        : this.#table.selectColumns(this.#projection);
    }

    const evaluators = this.#predicates.map((predicate) => predicate.bind(this.#table));
    const matches =
      evaluators.length === 1
        ? (evaluators[0] as (rowIndex: number) => boolean)
        : (rowIndex: number): boolean => {
            for (const evaluate of evaluators) {
              if (!evaluate(rowIndex)) {
                return false;
              }
            }

            return true;
          };
    const rowCount = this.#table.rowCount;

    if (rowCount <= SMALL_TABLE_SELECTION_LIMIT) {
      const indices = new Uint32Array(rowCount);
      let selectedCount = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (!matches(rowIndex)) {
          continue;
        }

        indices[selectedCount] = rowIndex;
        selectedCount += 1;
      }

      return this.#table.takeSelectionUnchecked(indices, selectedCount, this.#projection);
    }

    const sampleSize = SELECTION_SAMPLE_SIZE;
    let capacity = sampleSize;
    let indices = new Uint32Array(capacity);
    let selectedCount = 0;

    for (let rowIndex = 0; rowIndex < sampleSize; rowIndex += 1) {
      if (matches(rowIndex)) {
        indices[selectedCount] = rowIndex;
        selectedCount += 1;
      }
    }

    const estimatedCount = Math.ceil(
      (selectedCount / sampleSize) * rowCount * SELECTION_ESTIMATE_HEADROOM,
    );
    const estimatedCapacity = Math.min(rowCount, Math.max(sampleSize, estimatedCount));

    if (estimatedCapacity > capacity) {
      const expanded = new Uint32Array(estimatedCapacity);

      for (let index = 0; index < selectedCount; index += 1) {
        expanded[index] = indices[index] as number;
      }

      indices = expanded;
      capacity = estimatedCapacity;
    }

    for (let rowIndex = sampleSize; rowIndex < rowCount; rowIndex += 1) {
      if (!matches(rowIndex)) {
        continue;
      }

      if (selectedCount === capacity) {
        capacity = Math.min(rowCount, capacity * 2);
        const expanded = new Uint32Array(capacity);

        expanded.set(indices);
        indices = expanded;
      }

      indices[selectedCount] = rowIndex;
      selectedCount += 1;
    }

    return this.#table.takeSelectionUnchecked(indices, selectedCount, this.#projection);
  }
}

export class AggregateQuery {
  readonly #table: Table;
  readonly #spec: AggregateSpec;
  readonly #predicates: readonly Predicate[];
  readonly #options: AggregateOptions;

  constructor(
    table: Table,
    spec: AggregateSpec,
    predicates: readonly Predicate[],
    options: AggregateOptions,
  ) {
    this.#table = table;
    this.#spec = spec;
    this.#predicates = predicates;
    this.#options = options;
  }

  execute(): Record<string, number | null> {
    return aggregateTable(this.#table, this.#spec, this.#predicates, this.#options);
  }
}
