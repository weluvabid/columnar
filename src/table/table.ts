import type { Column } from '../column/column.js';
import { SchemaError } from '../core/errors.js';
import type { ColumnInput, Row } from '../core/types.js';
import { QueryBuilder } from '../execution/query.js';
import { createColumnsFromInput } from './from-columns.js';
import { createColumnsFromRows } from './from-rows.js';

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
    const built = createColumnsFromInput(columns);
    let rowCount = 0;

    for (const column of built.values()) {
      rowCount = column.length;
      break;
    }

    return new Table(built, rowCount);
  }

  static fromRows(rows: readonly Row[]): Table {
    return new Table(createColumnsFromRows(rows), rows.length);
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
    return this.takeSelection(indices, indices.length);
  }

  /** @internal Validates and materializes a prefix of selected rows. */
  takeSelection(
    indices: Uint32Array,
    selectedCount: number,
    projection?: readonly string[],
  ): Table {
    this.assertSelectionLength(indices, selectedCount);

    return this.materializeSelection(indices, selectedCount, projection, true);
  }

  /** @internal Materializes indices produced by this table's query executor. */
  takeSelectionUnchecked(
    indices: Uint32Array,
    selectedCount: number,
    projection?: readonly string[],
  ): Table {
    this.assertSelectionLength(indices, selectedCount);

    return this.materializeSelection(indices, selectedCount, projection, false);
  }

  private assertSelectionLength(indices: Uint32Array, selectedCount: number): void {
    if (!Number.isInteger(selectedCount) || selectedCount < 0 || selectedCount > indices.length) {
      throw new RangeError('Selected row count must be within the selection buffer bounds.');
    }
  }

  private materializeSelection(
    indices: Uint32Array,
    selectedCount: number,
    projection: readonly string[] | undefined,
    validateIndices: boolean,
  ): Table {
    const columns = new Map<string, Column>();
    let validated = !validateIndices;

    const takeColumn = (column: Column): Column => {
      if (!validated) {
        validated = true;

        return column.takeValidated(indices, selectedCount);
      }

      return column.takeUnchecked(indices, selectedCount);
    };

    if (projection === undefined) {
      for (const [name, column] of this.#columns) {
        columns.set(name, takeColumn(column));
      }
    } else {
      for (const name of projection) {
        if (columns.has(name)) {
          throw new SchemaError(`Column '${name}' was selected more than once.`);
        }

        columns.set(name, takeColumn(this.column(name)));
      }
    }

    if (!validated) {
      for (let index = 0; index < selectedCount; index += 1) {
        const source = indices[index] as number;

        if (source >= this.rowCount) {
          throw new RangeError(`Row index ${source} is outside [0, ${this.rowCount}).`);
        }
      }
    }

    return new Table(columns, selectedCount);
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
