import { createColumn, type Column } from '../column/column.js';
import { SchemaError } from '../core/errors.js';
import type { ColumnInput, Row, Scalar } from '../core/types.js';
import { QueryBuilder } from '../execution/query.js';

export class Table {
  readonly rowCount: number;
  readonly columnNames: readonly string[];
  readonly #columns: ReadonlyMap<string, Column>;

  private constructor(columns: ReadonlyMap<string, Column>, rowCount: number) {
    this.#columns = columns;
    this.rowCount = rowCount;
    this.columnNames = Object.freeze([...columns.keys()]);
  }

  static fromColumns(columns: Record<string, ColumnInput>): Table {
    const entries = Object.entries(columns);

    if (entries.length === 0) {
      return new Table(new Map(), 0);
    }

    const output = new Map<string, Column>();
    let rowCount: number | undefined;

    for (const [name, input] of entries) {
      if (name.length === 0) {
        throw new SchemaError('Column names cannot be empty.');
      }

      if (output.has(name)) {
        throw new SchemaError(`Duplicate column name: ${name}.`);
      }

      const column = createColumn(input);

      if (rowCount !== undefined && column.length !== rowCount) {
        throw new SchemaError(
          `Column '${name}' has ${column.length} values; expected ${rowCount}.`,
        );
      }

      rowCount = column.length;
      output.set(name, column);
    }

    return new Table(output, rowCount ?? 0);
  }

  static fromRows(rows: readonly Row[]): Table {
    if (rows.length === 0) {
      return new Table(new Map(), 0);
    }

    const names = Object.keys(rows[0] ?? {});

    if (names.length === 0) {
      throw new SchemaError('Cannot infer a schema from rows without columns.');
    }

    const nameSet = new Set(names);
    const columns = Object.create(null) as Record<string, (Scalar | undefined)[]>;

    for (const name of names) {
      columns[name] = new Array<Scalar | undefined>(rows.length);
    }

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];

      if (row === undefined || row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new SchemaError(`Row ${rowIndex} is not a record.`);
      }

      for (const key of Object.keys(row)) {
        if (!nameSet.has(key)) {
          throw new SchemaError(`Row ${rowIndex} contains unexpected column '${key}'.`);
        }
      }

      for (const name of names) {
        const column = columns[name];

        if (column === undefined) {
          throw new SchemaError(`Unable to construct column '${name}'.`);
        }

        column[rowIndex] = Object.hasOwn(row, name) ? row[name] : undefined;
      }
    }

    return Table.fromColumns(columns);
  }

  column(name: string): Column {
    const column = this.#columns.get(name);

    if (column === undefined) {
      throw new SchemaError(
        `Unknown column '${name}'. Available columns: ${this.columnNames.join(', ')}.`,
      );
    }

    return column;
  }

  hasColumn(name: string): boolean {
    return this.#columns.has(name);
  }

  query(): QueryBuilder {
    return new QueryBuilder(this);
  }

  take(indices: Uint32Array): Table {
    if (this.#columns.size === 0) {
      for (let index = 0; index < indices.length; index += 1) {
        if ((indices[index] ?? 0) >= this.rowCount) {
          throw new RangeError(`Row index ${indices[index]} is outside [0, ${this.rowCount}).`);
        }
      }
    }

    const columns = new Map<string, Column>();

    for (const [name, column] of this.#columns) {
      columns.set(name, column.take(indices));
    }

    return new Table(columns, indices.length);
  }

  selectColumns(names: readonly string[]): Table {
    const columns = new Map<string, Column>();

    for (const name of names) {
      if (columns.has(name)) {
        throw new SchemaError(`Column '${name}' was selected more than once.`);
      }

      columns.set(name, this.column(name));
    }

    return new Table(columns, this.rowCount);
  }

  toRows(): Row[] {
    const rows = new Array<Row>(this.rowCount);

    for (let rowIndex = 0; rowIndex < this.rowCount; rowIndex += 1) {
      const row: Row = {};

      for (const [name, column] of this.#columns) {
        Object.defineProperty(row, name, {
          value: column.get(rowIndex),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }

      rows[rowIndex] = row;
    }

    return rows;
  }

  getColumnEntries(): IterableIterator<[string, Column]> {
    return this.#columns.entries();
  }
}

export function table(rows: readonly Row[]): Table;

export function table(columns: Record<string, ColumnInput>): Table;

export function table(input: readonly Row[] | Record<string, ColumnInput>): Table {
  if (Array.isArray(input)) {
    return Table.fromRows(input);
  }

  return Table.fromColumns(input as Record<string, ColumnInput>);
}
