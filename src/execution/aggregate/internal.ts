import { SchemaError } from '../../core/errors.js';
import type { NumericArray } from '../../core/types.js';
import type { Column, ColumnKind } from '../../column/column.js';
import { AggregateIntent, ColumnKindIntent } from '../../core/intents.js';
import { BooleanColumn, DictionaryColumn, NumericColumn } from '../../column/column.js';
import type { AggregateExpression, AggregateKind, AggregateSpec } from './types.js';
import type { Table } from '../../table/table.js';

export const enum AggregateOpcode {
  Sum,
  Mean,
  Min,
  Max,
  Count,
  Variance,
}

export interface AggregateState {
  count: number;
  sum: number;
  compensation: number;
  mean: number;
  m2: number;
  min: number;
  max: number;
}

export interface AggregatePlan {
  readonly opcode: AggregateOpcode;
  readonly hasColumn: boolean;
  readonly state: AggregateState;
  values: NumericArray | undefined;
  validity: Uint32Array | undefined;
}

export interface NumericAggregateGroup {
  values: NumericArray;
  validity: Uint32Array | undefined;
  readonly plans: AggregatePlan[];
}

export function createStates(
  spec: AggregateSpec,
  table: Table,
  entries: readonly (readonly [string, AggregateExpression])[] = Object.entries(spec),
  target = new Map<string, AggregateState>(),
): Map<string, AggregateState> {
  for (const [name, expression] of entries) {
    assertAggregateKind(expression.kind);

    if (expression.column === undefined && expression.kind !== AggregateIntent.Count) {
      throw new SchemaError(`Aggregate '${expression.kind}' requires a column name.`);
    }

    if (expression.column !== undefined) {
      const column = table.column(expression.column);

      validateAggregateColumn(expression, column.kind);
    }

    target.set(name, createState());
  }

  return target;
}

export function finalizeSingle(
  expression: AggregateExpression,
  state: AggregateState,
): number | null {
  switch (expression.kind) {
    case AggregateIntent.Count:
      return state.count;
    case AggregateIntent.Sum:
      return state.count === 0 ? null : state.sum + state.compensation;
    case AggregateIntent.Mean:
      return state.count === 0 ? null : state.mean;
    case AggregateIntent.Min:
      return state.count === 0 ? null : state.min;
    case AggregateIntent.Max:
      return state.count === 0 ? null : state.max;
    case AggregateIntent.Variance:
      return state.count === 0 || (expression.sample === true && state.count < 2)
        ? null
        : state.m2 / (state.count - (expression.sample === true ? 1 : 0));
  }
}

export function assertAggregateKind(kind: string): asserts kind is AggregateKind {
  if (
    kind !== AggregateIntent.Sum &&
    kind !== AggregateIntent.Mean &&
    kind !== AggregateIntent.Min &&
    kind !== AggregateIntent.Max &&
    kind !== AggregateIntent.Count &&
    kind !== AggregateIntent.Variance
  ) {
    throw new SchemaError(`Unknown aggregate kind '${kind}'.`);
  }
}

export function validateAggregateColumn(expression: AggregateExpression, kind: ColumnKind): void {
  if (expression.kind === AggregateIntent.Count) {
    return;
  }

  if (expression.column === undefined) {
    throw new SchemaError(`Aggregate '${expression.kind}' requires a column name.`);
  }

  if (kind === ColumnKindIntent.Boolean || kind === ColumnKindIntent.Dictionary) {
    throw new SchemaError(`Aggregate '${expression.kind}' requires a numeric column.`);
  }
}

export function createState(): AggregateState {
  return {
    count: 0,
    sum: 0,
    compensation: 0,
    mean: 0,
    m2: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  };
}

export function getAggregateOpcode(kind: AggregateKind): AggregateOpcode {
  switch (kind) {
    case AggregateIntent.Sum:
      return AggregateOpcode.Sum;
    case AggregateIntent.Mean:
      return AggregateOpcode.Mean;
    case AggregateIntent.Min:
      return AggregateOpcode.Min;
    case AggregateIntent.Max:
      return AggregateOpcode.Max;
    case AggregateIntent.Count:
      return AggregateOpcode.Count;
    case AggregateIntent.Variance:
      return AggregateOpcode.Variance;
  }
}

export function updateState(state: AggregateState, opcode: AggregateOpcode, value: number): void {
  state.count += 1;

  switch (opcode) {
    case AggregateOpcode.Count:
      return;
    case AggregateOpcode.Sum: {
      const nextSum = state.sum + value;

      if (Number.isFinite(state.sum) && Number.isFinite(value) && Number.isFinite(nextSum)) {
        state.compensation +=
          Math.abs(state.sum) >= Math.abs(value)
            ? state.sum - nextSum + value
            : value - nextSum + state.sum;
      } else {
        state.compensation = 0;
      }

      state.sum = nextSum;

      return;
    }
    case AggregateOpcode.Mean: {
      state.mean += (value - state.mean) / state.count;

      return;
    }
    case AggregateOpcode.Min:
      state.min = Math.min(state.min, value);

      return;
    case AggregateOpcode.Max:
      state.max = Math.max(state.max, value);

      return;
    case AggregateOpcode.Variance: {
      const delta = value - state.mean;

      state.mean += delta / state.count;
      state.m2 += delta * (value - state.mean);

      return;
    }
  }
}

export function finalizeStates(
  spec: AggregateSpec,
  states: ReadonlyMap<string, AggregateState>,
  entries: readonly (readonly [string, AggregateExpression])[] = Object.entries(spec),
): Record<string, number | null> {
  const result: Record<string, number | null> = {};

  for (const [name, expression] of entries) {
    const state = states.get(name);

    if (state === undefined) {
      throw new SchemaError(`Missing aggregate state for '${name}'.`);
    }

    switch (expression.kind) {
      case AggregateIntent.Count:
        setResult(result, name, state.count);
        break;
      case AggregateIntent.Sum:
        setResult(result, name, state.count === 0 ? null : state.sum + state.compensation);
        break;
      case AggregateIntent.Mean:
        setResult(result, name, state.count === 0 ? null : state.mean);
        break;
      case AggregateIntent.Min:
        setResult(result, name, state.count === 0 ? null : state.min);
        break;
      case AggregateIntent.Max:
        setResult(result, name, state.count === 0 ? null : state.max);
        break;
      case AggregateIntent.Variance:
        setResult(
          result,
          name,
          state.count === 0 || (expression.sample === true && state.count < 2)
            ? null
            : state.m2 / (state.count - (expression.sample === true ? 1 : 0)),
        );
        break;
    }
  }

  return result;
}

export function getColumnValidity(column: Column | undefined): Uint32Array | undefined {
  if (
    column instanceof NumericColumn ||
    column instanceof BooleanColumn ||
    column instanceof DictionaryColumn
  ) {
    return column.validity;
  }

  return undefined;
}

export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function setResult(
  result: Record<string, number | null>,
  name: string,
  value: number | null,
): void {
  Object.defineProperty(result, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
