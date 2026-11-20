import { AbortExecutionError, SchemaError } from '../core/errors.js';
import type { NumericArray, Scalar } from '../core/types.js';
import type { Predicate } from '../expressions/predicate.js';
import { NumericColumn, type Column, type ColumnKind } from '../column/column.js';
import { isValid } from '../memory/validity.js';
import type { Table } from '../table/table.js';

export type AggregateKind = 'sum' | 'mean' | 'min' | 'max' | 'count' | 'variance';

export interface AggregateExpression {
  readonly kind: AggregateKind;
  readonly column?: string;
  readonly sample?: boolean;
}

export type AggregateSpec = Readonly<Record<string, AggregateExpression>>;

export interface AggregateOptions {
  readonly signal?: AbortSignal;
}

interface AggregateState {
  count: number;
  sum: number;
  compensation: number;
  mean: number;
  m2: number;
  min: number;
  max: number;
}

interface AggregatePlan {
  readonly expression: AggregateExpression;
  readonly state: AggregateState;
  readonly values: NumericArray | undefined;
  readonly validity: Uint32Array | undefined;
  readonly column: Column | undefined;
}

export function sum(column: string): AggregateExpression {
  return { kind: 'sum', column };
}

export function mean(column: string): AggregateExpression {
  return { kind: 'mean', column };
}

export function min(column: string): AggregateExpression {
  return { kind: 'min', column };
}

export function max(column: string): AggregateExpression {
  return { kind: 'max', column };
}

export function count(column?: string): AggregateExpression {
  return column === undefined ? { kind: 'count' } : { kind: 'count', column };
}

export function variance(column: string, sample = false): AggregateExpression {
  return { kind: 'variance', column, sample };
}

export function aggregateTable(
  table: Table,
  spec: AggregateSpec,
  predicates: readonly Predicate[] = [],
  options: AggregateOptions = {},
): Record<string, number | null> {
  const states = createStates(spec, table);
  const evaluators = predicates.map((predicate) => predicate.bind(table));
  const plans: AggregatePlan[] = [];

  for (const [name, expression] of Object.entries(spec)) {
    const state = states.get(name);

    if (state === undefined) {
      throw new SchemaError(`Missing aggregate state for '${name}'.`);
    }

    const column = expression.column === undefined ? undefined : table.column(expression.column);
    const numericColumn = column instanceof NumericColumn ? column : undefined;

    plans.push({
      expression,
      state,
      values: numericColumn?.values,
      validity: numericColumn?.validity,
      column: numericColumn === undefined ? column : undefined,
    });
  }

  const signal = options.signal;

  if (signal?.aborted === true) {
    throw new AbortExecutionError();
  }

  if (plans.length === 1 && evaluators.length <= 1) {
    const plan = plans[0];

    if (plan !== undefined && plan.values !== undefined) {
      aggregateSingleNumeric(plan, table.rowCount, evaluators[0], signal);

      return finalizeStates(spec, states);
    }
  }

  for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex += 1) {
    if (signal !== undefined && signal.aborted) {
      throw new AbortExecutionError();
    }

    let matches = true;

    for (let predicateIndex = 0; predicateIndex < evaluators.length; predicateIndex += 1) {
      const evaluate = evaluators[predicateIndex];

      if (evaluate === undefined || !evaluate(rowIndex)) {
        matches = false;
        break;
      }
    }

    if (!matches) {
      continue;
    }

    for (let planIndex = 0; planIndex < plans.length; planIndex += 1) {
      const plan = plans[planIndex];

      if (plan === undefined) {
        continue;
      }

      let value: Scalar;

      if (plan.values !== undefined) {
        if (plan.validity !== undefined && !isValid(plan.validity, rowIndex)) {
          continue;
        }

        value = plan.values[rowIndex] ?? 0;
      } else if (plan.column !== undefined) {
        value = plan.column.getUnchecked(rowIndex);
      } else {
        value = 1;
      }

      if (value === null) {
        continue;
      }

      if (typeof value !== 'number') {
        plan.state.count += 1;
        continue;
      }

      updateState(plan.state, plan.expression, value);
    }
  }

  return finalizeStates(spec, states);
}

export async function aggregateStream(
  chunks: AsyncIterable<Table>,
  spec: AggregateSpec,
  options: AggregateOptions & { readonly where?: Predicate } = {},
): Promise<Record<string, number | null>> {
  if (isAborted(options.signal)) {
    throw new AbortExecutionError();
  }

  const states = new Map<string, AggregateState>();
  const expressions = Object.entries(spec);
  let initialized = false;

  for (const [, expression] of expressions) {
    assertAggregateKind(expression.kind);

    if (expression.kind !== 'count' && expression.column === undefined) {
      throw new SchemaError(`Aggregate '${expression.kind}' requires a column name.`);
    }
  }

  for await (const chunk of chunks) {
    if (isAborted(options.signal)) {
      throw new AbortExecutionError();
    }

    if (!initialized) {
      createStates(spec, chunk, states);
      initialized = true;
    }

    const evaluators = options.where?.bind(chunk);
    const chunkPlans: AggregatePlan[] = [];

    for (const [name, expression] of expressions) {
      const state = states.get(name);

      if (state === undefined) {
        throw new SchemaError(`Missing aggregate state for '${name}'.`);
      }

      const column = expression.column === undefined ? undefined : chunk.column(expression.column);

      if (column !== undefined) {
        validateAggregateColumn(expression, column.kind);
      }

      const numericColumn = column instanceof NumericColumn ? column : undefined;

      chunkPlans.push({
        expression,
        state,
        values: numericColumn?.values,
        validity: numericColumn?.validity,
        column: numericColumn === undefined ? column : undefined,
      });
    }

    for (let rowIndex = 0; rowIndex < chunk.rowCount; rowIndex += 1) {
      if (isAborted(options.signal)) {
        throw new AbortExecutionError();
      }

      if (evaluators !== undefined && !evaluators(rowIndex)) {
        continue;
      }

      for (let planIndex = 0; planIndex < chunkPlans.length; planIndex += 1) {
        const plan = chunkPlans[planIndex];

        if (plan === undefined) {
          continue;
        }

        let value: Scalar;

        if (plan.values !== undefined) {
          if (plan.validity !== undefined && !isValid(plan.validity, rowIndex)) {
            continue;
          }

          value = plan.values[rowIndex] ?? 0;
        } else if (plan.column !== undefined) {
          value = plan.column.getUnchecked(rowIndex);
        } else {
          value = 1;
        }

        if (value === null) {
          continue;
        }

        if (typeof value !== 'number') {
          plan.state.count += 1;
          continue;
        }

        updateState(plan.state, plan.expression, value);
      }
    }
  }

  if (!initialized) {
    for (const [name] of expressions) {
      states.set(name, createState());
    }
  }

  return finalizeStates(spec, states);
}

function createStates(
  spec: AggregateSpec,
  table: Table,
  target = new Map<string, AggregateState>(),
): Map<string, AggregateState> {
  for (const [name, expression] of Object.entries(spec)) {
    assertAggregateKind(expression.kind);

    if (expression.column === undefined && expression.kind !== 'count') {
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

function aggregateSingleNumeric(
  plan: AggregatePlan,
  rowCount: number,
  predicate: ((rowIndex: number) => boolean) | undefined,
  signal: AbortSignal | undefined,
): void {
  const values = plan.values;
  const validity = plan.validity;
  const state = plan.state;
  const kind = plan.expression.kind;

  if (values === undefined) {
    return;
  }

  switch (kind) {
    case 'sum': {
      let total = 0;
      let compensation = 0;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (signal !== undefined && signal.aborted) {
          throw new AbortExecutionError();
        }

        if (predicate !== undefined && !predicate(rowIndex)) {
          continue;
        }

        if (validity !== undefined && !isValid(validity, rowIndex)) {
          continue;
        }

        const value = values[rowIndex] ?? 0;
        const nextTotal = total + value;

        if (Number.isFinite(total) && Number.isFinite(value) && Number.isFinite(nextTotal)) {
          compensation +=
            Math.abs(total) >= Math.abs(value)
              ? total - nextTotal + value
              : value - nextTotal + total;
        } else {
          compensation = 0;
        }

        total = nextTotal;
        count += 1;
      }

      state.sum = total;
      state.compensation = compensation;
      state.count = count;

      return;
    }
    case 'mean': {
      let average = 0;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (signal !== undefined && signal.aborted) {
          throw new AbortExecutionError();
        }

        if (predicate !== undefined && !predicate(rowIndex)) {
          continue;
        }

        if (validity !== undefined && !isValid(validity, rowIndex)) {
          continue;
        }

        const value = values[rowIndex] ?? 0;

        count += 1;
        average += (value - average) / count;
      }

      state.mean = average;
      state.count = count;

      return;
    }
    case 'min': {
      let minimum = Number.POSITIVE_INFINITY;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (signal !== undefined && signal.aborted) {
          throw new AbortExecutionError();
        }

        if (predicate !== undefined && !predicate(rowIndex)) {
          continue;
        }

        if (validity !== undefined && !isValid(validity, rowIndex)) {
          continue;
        }

        minimum = Math.min(minimum, values[rowIndex] ?? 0);
        count += 1;
      }

      state.min = minimum;
      state.count = count;

      return;
    }
    case 'max': {
      let maximum = Number.NEGATIVE_INFINITY;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (signal !== undefined && signal.aborted) {
          throw new AbortExecutionError();
        }

        if (predicate !== undefined && !predicate(rowIndex)) {
          continue;
        }

        if (validity !== undefined && !isValid(validity, rowIndex)) {
          continue;
        }

        maximum = Math.max(maximum, values[rowIndex] ?? 0);
        count += 1;
      }

      state.max = maximum;
      state.count = count;

      return;
    }
    case 'variance': {
      let average = 0;
      let m2 = 0;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (signal !== undefined && signal.aborted) {
          throw new AbortExecutionError();
        }

        if (predicate !== undefined && !predicate(rowIndex)) {
          continue;
        }

        if (validity !== undefined && !isValid(validity, rowIndex)) {
          continue;
        }

        const value = values[rowIndex] ?? 0;

        count += 1;
        const delta = value - average;

        average += delta / count;
        m2 += delta * (value - average);
      }

      state.mean = average;
      state.m2 = m2;
      state.count = count;

      return;
    }
    case 'count': {
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (signal !== undefined && signal.aborted) {
          throw new AbortExecutionError();
        }

        if (predicate !== undefined && !predicate(rowIndex)) {
          continue;
        }

        if (validity === undefined || isValid(validity, rowIndex)) {
          count += 1;
        }
      }

      state.count = count;

      return;
    }
  }
}

function assertAggregateKind(kind: string): asserts kind is AggregateKind {
  if (
    kind !== 'sum' &&
    kind !== 'mean' &&
    kind !== 'min' &&
    kind !== 'max' &&
    kind !== 'count' &&
    kind !== 'variance'
  ) {
    throw new SchemaError(`Unknown aggregate kind '${kind}'.`);
  }
}

function validateAggregateColumn(expression: AggregateExpression, kind: ColumnKind): void {
  if (expression.kind === 'count') {
    return;
  }

  if (expression.column === undefined) {
    throw new SchemaError(`Aggregate '${expression.kind}' requires a column name.`);
  }

  if (kind === 'boolean' || kind === 'dictionary') {
    throw new SchemaError(`Aggregate '${expression.kind}' requires a numeric column.`);
  }
}

function createState(): AggregateState {
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

function updateState(state: AggregateState, expression: AggregateExpression, value: number): void {
  state.count += 1;

  switch (expression.kind) {
    case 'count':
      return;
    case 'sum': {
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
    case 'mean': {
      state.mean += (value - state.mean) / state.count;

      return;
    }
    case 'min':
      state.min = Math.min(state.min, value);

      return;
    case 'max':
      state.max = Math.max(state.max, value);

      return;
    case 'variance': {
      const delta = value - state.mean;

      state.mean += delta / state.count;
      state.m2 += delta * (value - state.mean);

      return;
    }
  }
}

function finalizeStates(
  spec: AggregateSpec,
  states: ReadonlyMap<string, AggregateState>,
): Record<string, number | null> {
  const result: Record<string, number | null> = {};

  for (const [name, expression] of Object.entries(spec)) {
    const state = states.get(name);

    if (state === undefined) {
      throw new SchemaError(`Missing aggregate state for '${name}'.`);
    }

    switch (expression.kind) {
      case 'count':
        setResult(result, name, state.count);
        break;
      case 'sum':
        setResult(result, name, state.count === 0 ? null : state.sum + state.compensation);
        break;
      case 'mean':
        setResult(result, name, state.count === 0 ? null : state.mean);
        break;
      case 'min':
        setResult(result, name, state.count === 0 ? null : state.min);
        break;
      case 'max':
        setResult(result, name, state.count === 0 ? null : state.max);
        break;
      case 'variance':
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

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function setResult(
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
