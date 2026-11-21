import { BooleanColumn, DictionaryColumn, NumericColumn } from '../column/column.js';
import type { Column } from '../column/base.js';
import { SchemaError } from '../core/errors.js';
import { ValueKindIntent } from '../core/intents.js';
import type { NumericArray, Row } from '../core/types.js';
import { setValidPrefix } from '../memory/validity.js';

type ColumnValueKind = ValueKindIntent;

interface ColumnBuilder {
  kind: ColumnValueKind | undefined;
  values: NumericArray | undefined;
  validity: Uint32Array | undefined;
  dictionary: string[] | undefined;
  dictionaryMap: Map<string, number> | undefined;
}

export function createColumnsFromRows(rows: readonly Row[]): ReadonlyMap<string, Column> {
  if (rows.length === 0) {
    return new Map();
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

      if (
        valueType !== ValueKindIntent.Number &&
        valueType !== ValueKindIntent.String &&
        valueType !== ValueKindIntent.Boolean
      ) {
        throw new SchemaError(`Unsupported column value: ${String(value)}.`);
      }

      if (builder.kind === undefined) {
        builder.kind = valueType;

        if (valueType === ValueKindIntent.String) {
          builder.values = new Uint32Array(rows.length);
          builder.dictionary = [];
          builder.dictionaryMap = new Map<string, number>();
        } else if (valueType === ValueKindIntent.Boolean) {
          builder.values = new Uint8Array(rows.length);
        } else {
          builder.values = new Float64Array(rows.length);
        }
      } else if (builder.kind !== valueType) {
        throw new SchemaError(
          `Mixed column types are not supported (${builder.kind} and ${valueType}).`,
        );
      }

      if (builder.kind === ValueKindIntent.String) {
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
      } else if (builder.kind === ValueKindIntent.Boolean) {
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
    const kind = builder.kind ?? ValueKindIntent.Number;
    const values = builder.values ?? new Float64Array(rows.length);

    if (kind === ValueKindIntent.String) {
      columns.set(
        name,
        new DictionaryColumn(
          values as Uint32Array,
          builder.dictionary as string[],
          builder.validity,
        ),
      );
    } else if (kind === ValueKindIntent.Boolean) {
      columns.set(name, new BooleanColumn(values as Uint8Array, builder.validity));
    } else {
      columns.set(name, new NumericColumn(values, builder.validity));
    }
  }

  return columns;
}
