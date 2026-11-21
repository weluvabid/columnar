import type { Column } from '../column/base.js';
import { createColumn } from '../column/factory.js';
import { SchemaError } from '../core/errors.js';
import type { ColumnInput } from '../core/types.js';

export function createColumnsFromInput(
  columns: Record<string, ColumnInput>,
): ReadonlyMap<string, Column> {
  const entries = Object.entries(columns);

  if (entries.length === 0) {
    return new Map();
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
      throw new SchemaError(`Column '${name}' has ${column.length} values; expected ${rowCount}.`);
    }

    rowCount = column.length;
    output.set(name, column);
  }

  return output;
}
