import type { AggregateOptions, AggregateSpec } from './aggregate.js';
import { aggregateTable } from './aggregate.js';
import { SchemaError } from '../core/errors.js';
import type { Predicate } from '../expressions/predicate.js';
import type { Table } from '../table/table.js';

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
    const source =
      this.#projection === undefined ? this.#table : this.#table.selectColumns(this.#projection);

    if (this.#predicates.length === 0) {
      return source;
    }

    const singleEvaluator =
      this.#predicates.length === 1 ? this.#predicates[0]?.bind(this.#table) : undefined;
    const evaluators =
      this.#predicates.length > 1
        ? this.#predicates.map((predicate) => predicate.bind(this.#table))
        : undefined;
    const indices = new Uint32Array(this.#table.rowCount);
    let selectedCount = 0;

    for (let rowIndex = 0; rowIndex < this.#table.rowCount; rowIndex += 1) {
      if (singleEvaluator !== undefined) {
        if (!singleEvaluator(rowIndex)) {
          continue;
        }
      } else if (evaluators !== undefined) {
        let matches = true;

        for (const evaluate of evaluators) {
          if (!evaluate(rowIndex)) {
            matches = false;
            break;
          }
        }

        if (!matches) {
          continue;
        }
      }

      indices[selectedCount] = rowIndex;
      selectedCount += 1;
    }

    return source.take(indices.subarray(0, selectedCount));
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
