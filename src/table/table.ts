import {
  BooleanColumn,
  createColumn,
  DictionaryColumn,
  NumericColumn,
  type Column,
} from '../column/column.js';
import { SchemaError } from '../core/errors.js';
import type { ColumnInput, NumericArray, Row } from '../core/types.js';
import { QueryBuilder } from '../execution/query.js';
import { setValidPrefix } from '../memory/validity.js';

type ColumnValueKind = 'number' | 'string' | 'boolean';

interface ColumnBuilder {
  kind: ColumnValueKind | undefined;
  values: NumericArray | undefined;
  validity: Uint32Array | undefined;
  dictionary: string[] | undefined;
  dictionaryMap: Map<string, number> | undefined;
}

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
    }

    const builders: ColumnBuilder[] = new Array(names.length);

    for (let columnIndex = 0; columnIndex < names.length; columnIndex += 1) {
      builders[columnIndex] = {
        kind: undefined,
        values: undefined,
        validity: undefined,
        dictionary: undefined,
        dictionaryMap: undefined,
      };
    }

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] as Row;

      for (let columnIndex = 0; columnIndex < names.length; columnIndex += 1) {
        const name = names[columnIndex] as string;
        const builder = builders[columnIndex] as ColumnBuilder;
        const value = Object.hasOwn(row, name) ? row[name] : undefined;

        if (value === null || value === undefined) {
          if (builder.validity === undefined) {
            const validity = new Uint32Array(Math.ceil(rows.length / 32));

            if (builder.kind !== undefined) {
              setValidPrefix(validity, rowIndex);
            }

            builder.validity = validity;
          }

          continue;
        }

        const valueType = typeof value;

        if (valueType !== 'number' && valueType !== 'string' && valueType !== 'boolean') {
          throw new SchemaError(`Unsupported column value: ${String(value)}.`);
        }

        if (builder.kind === undefined) {
          builder.kind = valueType;

          if (valueType === 'string') {
            builder.values = new Uint32Array(rows.length);
            builder.dictionary = [];
            builder.dictionaryMap = new Map<string, number>();
          } else if (valueType === 'boolean') {
            builder.values = new Uint8Array(rows.length);
          } else {
            builder.values = new Float64Array(rows.length);
          }
        } else if (builder.kind !== valueType) {
          throw new SchemaError(
            `Mixed column types are not supported (${builder.kind} and ${valueType}).`,
          );
        }

        if (builder.kind === 'string') {
          const dictionary = builder.dictionary as string[];
          const dictionaryMap = builder.dictionaryMap as Map<string, number>;
          const stringValue = value as string;
          let dictionaryIndex = dictionaryMap.get(stringValue);

          if (dictionaryIndex === undefined) {
            dictionaryIndex = dictionary.length;
            dictionaryMap.set(stringValue, dictionaryIndex);
            dictionary.push(stringValue);
          }

          (builder.values as Uint32Array)[rowIndex] = dictionaryIndex;
        } else if (builder.kind === 'boolean') {
          (builder.values as Uint8Array)[rowIndex] = value === true ? 1 : 0;
        } else {
          (builder.values as Float64Array)[rowIndex] = value as number;
        }

        if (builder.validity !== undefined) {
          builder.validity[rowIndex >>> 5] =
            (builder.validity[rowIndex >>> 5] as number) | (1 << (rowIndex & 31));
        }
      }
    }

    const columns = new Map<string, Column>();

    for (let columnIndex = 0; columnIndex < names.length; columnIndex += 1) {
      const name = names[columnIndex] as string;
      const builder = builders[columnIndex] as ColumnBuilder;
      const kind = builder.kind ?? 'number';
      const values = builder.values ?? new Float64Array(rows.length);

      if (kind === 'string') {
        columns.set(
          name,
          new DictionaryColumn(
            values as Uint32Array,
            builder.dictionary as string[],
            builder.validity,
          ),
        );
      } else if (kind === 'boolean') {
        columns.set(name, new BooleanColumn(values as Uint8Array, builder.validity));
      } else {
        columns.set(name, new NumericColumn(values, builder.validity));
      }
    }

    return new Table(columns, rows.length);
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
