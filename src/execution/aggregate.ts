import { AbortExecutionError, SchemaError } from '../core/errors.js';
import type { NumericArray } from '../core/types.js';
import {
  compileNumericPredicatePlan,
  NumericPredicateOperator,
  type NumericPredicatePlan,
  type Predicate,
} from '../expressions/predicate.js';
import {
  BooleanColumn,
  DictionaryColumn,
  NumericColumn,
  type Column,
  type ColumnKind,
} from '../column/column.js';
import type { Table } from '../table/table.js';

export type AggregateKind = 'sum' | 'mean' | 'min' | 'max' | 'count' | 'variance';

const enum AggregateOpcode {
  Sum,
  Mean,
  Min,
  Max,
  Count,
  Variance,
}

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
  readonly opcode: AggregateOpcode;
  readonly hasColumn: boolean;
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
  const signal = options.signal;

  if (signal?.aborted === true) {
    throw new AbortExecutionError();
  }

  const entries = Object.entries(spec);

  if (entries.length === 1) {
    const entry = entries[0];

    if (entry !== undefined) {
      const [name, expression] = entry;

      assertAggregateKind(expression.kind);

      if (expression.column === undefined && expression.kind !== 'count') {
        throw new SchemaError(`Aggregate '${expression.kind}' requires a column name.`);
      }

      const column = expression.column === undefined ? undefined : table.column(expression.column);

      if (column !== undefined) {
        validateAggregateColumn(expression, column.kind);
      }

      if (column instanceof NumericColumn) {
        const predicatePlan = compileNumericPredicatePlan(predicates, table);

        if (predicatePlan !== undefined) {
          const state = aggregateSingleNumeric(
            expression,
            column.values,
            column.validity,
            table.rowCount,
            predicatePlan,
            signal,
          );
          const result: Record<string, number | null> = {};

          setResult(result, name, finalizeSingle(expression, state));

          return result;
        }
      }
    }
  }

  const states = createStates(spec, table, entries);
  const evaluators = predicates.map((predicate) => predicate.bind(table));
  const plans: AggregatePlan[] = [];

  for (const [name, expression] of entries) {
    const state = states.get(name);

    if (state === undefined) {
      throw new SchemaError(`Missing aggregate state for '${name}'.`);
    }

    const column = expression.column === undefined ? undefined : table.column(expression.column);
    const numericColumn = column instanceof NumericColumn ? column : undefined;

    plans.push({
      opcode: getAggregateOpcode(expression.kind),
      hasColumn: expression.column !== undefined,
      state,
      values: numericColumn?.values,
      validity: getColumnValidity(column),
      column: numericColumn === undefined ? column : undefined,
    });
  }

  for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex += 1) {
    if ((rowIndex & 4095) === 0 && isAborted(signal)) {
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

      if (plan.opcode === AggregateOpcode.Count) {
        if (
          !plan.hasColumn ||
          plan.validity === undefined ||
          ((plan.validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0
        ) {
          plan.state.count += 1;
        }

        continue;
      }

      if (plan.values !== undefined) {
        if (
          plan.validity !== undefined &&
          ((plan.validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0
        ) {
          continue;
        }

        updateState(plan.state, plan.opcode, plan.values[rowIndex] as number);
      } else if (plan.column !== undefined) {
        const value = plan.column.getUnchecked(rowIndex);

        if (typeof value === 'number') {
          updateState(plan.state, plan.opcode, value);
        }
      }
    }
  }

  return finalizeStates(spec, states, entries);
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
      createStates(spec, chunk, expressions, states);
      initialized = true;
    }

    const predicatePlan =
      options.where === undefined ? undefined : compileNumericPredicatePlan([options.where], chunk);
    const evaluator =
      options.where === undefined || predicatePlan !== undefined
        ? undefined
        : options.where.bind(chunk);
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
        opcode: getAggregateOpcode(expression.kind),
        hasColumn: expression.column !== undefined,
        state,
        values: numericColumn?.values,
        validity: getColumnValidity(column),
        column: numericColumn === undefined ? column : undefined,
      });
    }

    for (let rowIndex = 0; rowIndex < chunk.rowCount; rowIndex += 1) {
      if ((rowIndex & 4095) === 0 && isAborted(options.signal)) {
        throw new AbortExecutionError();
      }

      if (predicatePlan !== undefined && !matchesNumericPredicatePlan(predicatePlan, rowIndex)) {
        continue;
      }

      if (evaluator !== undefined && !evaluator(rowIndex)) {
        continue;
      }

      for (let planIndex = 0; planIndex < chunkPlans.length; planIndex += 1) {
        const plan = chunkPlans[planIndex];

        if (plan === undefined) {
          continue;
        }

        if (plan.opcode === AggregateOpcode.Count) {
          if (
            !plan.hasColumn ||
            plan.validity === undefined ||
            ((plan.validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0
          ) {
            plan.state.count += 1;
          }

          continue;
        }

        if (plan.values !== undefined) {
          if (
            plan.validity !== undefined &&
            ((plan.validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0
          ) {
            continue;
          }

          updateState(plan.state, plan.opcode, plan.values[rowIndex] as number);
        } else if (plan.column !== undefined) {
          const value = plan.column.getUnchecked(rowIndex);

          if (typeof value === 'number') {
            updateState(plan.state, plan.opcode, value);
          }
        }
      }
    }
  }

  if (!initialized) {
    for (const [name] of expressions) {
      states.set(name, createState());
    }
  }

  return finalizeStates(spec, states, expressions);
}

function createStates(
  spec: AggregateSpec,
  table: Table,
  entries: readonly (readonly [string, AggregateExpression])[] = Object.entries(spec),
  target = new Map<string, AggregateState>(),
): Map<string, AggregateState> {
  for (const [name, expression] of entries) {
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
  expression: AggregateExpression,
  values: NumericArray,
  validity: Uint32Array | undefined,
  rowCount: number,
  predicates: NumericPredicatePlan,
  signal: AbortSignal | undefined,
): AggregateState {
  const state = createState();
  const kind = expression.kind;
  const predicateCount = predicates.operators.length;
  let predicateGuaranteesValueValid = false;

  for (let index = 0; index < predicateCount; index += 1) {
    if (
      predicates.values[index] === values &&
      predicates.operators[index] !== NumericPredicateOperator.IsNull
    ) {
      predicateGuaranteesValueValid = true;
      break;
    }
  }

  if (predicates.alwaysFalse) {
    return state;
  }

  if (
    kind === 'sum' &&
    predicateCount === 1 &&
    predicates.operators[0] === NumericPredicateOperator.GreaterThan
  ) {
    return aggregateSumGreaterThan(
      values,
      validity,
      rowCount,
      predicates.values[0] as NumericArray,
      predicates.validity[0],
      predicates.operands[0] as number,
      state,
      signal,
    );
  }

  switch (kind) {
    case 'sum': {
      let total = 0;
      let compensation = 0;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if ((rowIndex & 4095) === 0 && signal?.aborted === true) {
          throw new AbortExecutionError();
        }

        if (predicateCount === 1) {
          const bitmap = predicates.validity[0];
          const predicateValid =
            bitmap === undefined ||
            ((bitmap[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;
          const predicateValue = (predicates.values[0] as NumericArray)[rowIndex] as number;
          const operand = predicates.operands[0] as number;
          const operator = predicates.operators[0];
          let matches = false;

          switch (operator) {
            case NumericPredicateOperator.Equal:
              matches = predicateValid && predicateValue === operand;
              break;
            case NumericPredicateOperator.NotEqual:
              matches = predicateValid && predicateValue !== operand;
              break;
            case NumericPredicateOperator.GreaterThan:
              matches = predicateValid && predicateValue > operand;
              break;
            case NumericPredicateOperator.GreaterThanOrEqual:
              matches = predicateValid && predicateValue >= operand;
              break;
            case NumericPredicateOperator.LessThan:
              matches = predicateValid && predicateValue < operand;
              break;
            case NumericPredicateOperator.LessThanOrEqual:
              matches = predicateValid && predicateValue <= operand;
              break;
            case NumericPredicateOperator.IsNull:
              matches = !predicateValid;
              break;
            case NumericPredicateOperator.IsNotNull:
              matches = predicateValid;
              break;
          }

          if (!matches) {
            continue;
          }
        } else if (predicateCount > 1) {
          let matches = true;

          for (let predicateIndex = 0; predicateIndex < predicateCount; predicateIndex += 1) {
            const bitmap = predicates.validity[predicateIndex];
            const predicateValid =
              bitmap === undefined ||
              ((bitmap[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;
            const predicateValue = (predicates.values[predicateIndex] as NumericArray)[
              rowIndex
            ] as number;
            const operand = predicates.operands[predicateIndex] as number;
            const operator = predicates.operators[predicateIndex];

            switch (operator) {
              case NumericPredicateOperator.Equal:
                matches = predicateValid && predicateValue === operand;
                break;
              case NumericPredicateOperator.NotEqual:
                matches = predicateValid && predicateValue !== operand;
                break;
              case NumericPredicateOperator.GreaterThan:
                matches = predicateValid && predicateValue > operand;
                break;
              case NumericPredicateOperator.GreaterThanOrEqual:
                matches = predicateValid && predicateValue >= operand;
                break;
              case NumericPredicateOperator.LessThan:
                matches = predicateValid && predicateValue < operand;
                break;
              case NumericPredicateOperator.LessThanOrEqual:
                matches = predicateValid && predicateValue <= operand;
                break;
              case NumericPredicateOperator.IsNull:
                matches = !predicateValid;
                break;
              case NumericPredicateOperator.IsNotNull:
                matches = predicateValid;
                break;
            }

            if (!matches) {
              break;
            }
          }

          if (!matches) {
            continue;
          }
        }

        if (
          !predicateGuaranteesValueValid &&
          validity !== undefined &&
          ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0
        ) {
          continue;
        }

        const value = values[rowIndex] as number;
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

      return state;
    }
    case 'mean': {
      let average = 0;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if ((rowIndex & 4095) === 0 && signal?.aborted === true) {
          throw new AbortExecutionError();
        }

        if (predicateCount !== 0 && !matchesNumericPredicatePlan(predicates, rowIndex)) {
          continue;
        }

        if (
          !predicateGuaranteesValueValid &&
          validity !== undefined &&
          ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0
        ) {
          continue;
        }

        const value = values[rowIndex] as number;

        count += 1;
        average += (value - average) / count;
      }

      state.mean = average;
      state.count = count;

      return state;
    }
    case 'min': {
      let minimum = Number.POSITIVE_INFINITY;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if ((rowIndex & 4095) === 0 && signal?.aborted === true) {
          throw new AbortExecutionError();
        }

        if (predicateCount !== 0 && !matchesNumericPredicatePlan(predicates, rowIndex)) {
          continue;
        }

        if (
          !predicateGuaranteesValueValid &&
          validity !== undefined &&
          ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0
        ) {
          continue;
        }

        minimum = Math.min(minimum, values[rowIndex] as number);
        count += 1;
      }

      state.min = minimum;
      state.count = count;

      return state;
    }
    case 'max': {
      let maximum = Number.NEGATIVE_INFINITY;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if ((rowIndex & 4095) === 0 && signal?.aborted === true) {
          throw new AbortExecutionError();
        }

        if (predicateCount !== 0 && !matchesNumericPredicatePlan(predicates, rowIndex)) {
          continue;
        }

        if (
          !predicateGuaranteesValueValid &&
          validity !== undefined &&
          ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0
        ) {
          continue;
        }

        maximum = Math.max(maximum, values[rowIndex] as number);
        count += 1;
      }

      state.max = maximum;
      state.count = count;

      return state;
    }
    case 'variance': {
      let average = 0;
      let m2 = 0;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if ((rowIndex & 4095) === 0 && signal?.aborted === true) {
          throw new AbortExecutionError();
        }

        if (predicateCount !== 0 && !matchesNumericPredicatePlan(predicates, rowIndex)) {
          continue;
        }

        if (
          !predicateGuaranteesValueValid &&
          validity !== undefined &&
          ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0
        ) {
          continue;
        }

        const value = values[rowIndex] as number;

        count += 1;
        const delta = value - average;

        average += delta / count;
        m2 += delta * (value - average);
      }

      state.mean = average;
      state.m2 = m2;
      state.count = count;

      return state;
    }
    case 'count': {
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if ((rowIndex & 4095) === 0 && signal?.aborted === true) {
          throw new AbortExecutionError();
        }

        if (predicateCount !== 0 && !matchesNumericPredicatePlan(predicates, rowIndex)) {
          continue;
        }

        if (
          predicateGuaranteesValueValid ||
          validity === undefined ||
          ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0
        ) {
          count += 1;
        }
      }

      state.count = count;

      return state;
    }
  }
}

function aggregateSumGreaterThan(
  values: NumericArray,
  validity: Uint32Array | undefined,
  rowCount: number,
  predicateValues: NumericArray,
  predicateValidity: Uint32Array | undefined,
  threshold: number,
  state: AggregateState,
  signal: AbortSignal | undefined,
): AggregateState {
  const sharedValues = values === predicateValues;
  let total = 0;
  let compensation = 0;
  let count = 0;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    if ((rowIndex & 4095) === 0 && signal?.aborted === true) {
      throw new AbortExecutionError();
    }

    if (
      predicateValidity !== undefined &&
      ((predicateValidity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0
    ) {
      continue;
    }

    if (!((predicateValues[rowIndex] as number) > threshold)) {
      continue;
    }

    if (
      !sharedValues &&
      validity !== undefined &&
      ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0
    ) {
      continue;
    }

    const value = values[rowIndex] as number;
    const nextTotal = total + value;

    if (Number.isFinite(total) && Number.isFinite(value) && Number.isFinite(nextTotal)) {
      compensation +=
        Math.abs(total) >= Math.abs(value) ? total - nextTotal + value : value - nextTotal + total;
    } else {
      compensation = 0;
    }

    total = nextTotal;
    count += 1;
  }

  state.sum = total;
  state.compensation = compensation;
  state.count = count;

  return state;
}

function matchesNumericPredicatePlan(plan: NumericPredicatePlan, rowIndex: number): boolean {
  const { values, validity, operators, operands } = plan;
  const predicateCount = operators.length;

  if (predicateCount === 1) {
    const bitmap = validity[0];
    const valid =
      bitmap === undefined || ((bitmap[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;
    const operator = operators[0];

    switch (operator) {
      case NumericPredicateOperator.Equal:
        return valid && (values[0] as NumericArray)[rowIndex] === operands[0];
      case NumericPredicateOperator.NotEqual:
        return valid && (values[0] as NumericArray)[rowIndex] !== operands[0];
      case NumericPredicateOperator.GreaterThan:
        return valid && ((values[0] as NumericArray)[rowIndex] as number) > (operands[0] as number);
      case NumericPredicateOperator.GreaterThanOrEqual:
        return (
          valid && ((values[0] as NumericArray)[rowIndex] as number) >= (operands[0] as number)
        );
      case NumericPredicateOperator.LessThan:
        return valid && ((values[0] as NumericArray)[rowIndex] as number) < (operands[0] as number);
      case NumericPredicateOperator.LessThanOrEqual:
        return (
          valid && ((values[0] as NumericArray)[rowIndex] as number) <= (operands[0] as number)
        );
      case NumericPredicateOperator.IsNull:
        return !valid;
      case NumericPredicateOperator.IsNotNull:
        return valid;
      default:
        return false;
    }
  }

  for (let predicateIndex = 0; predicateIndex < predicateCount; predicateIndex += 1) {
    const bitmap = validity[predicateIndex];
    const valid =
      bitmap === undefined || ((bitmap[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;
    const operator = operators[predicateIndex];

    switch (operator) {
      case NumericPredicateOperator.Equal:
        if (
          !valid ||
          (values[predicateIndex] as NumericArray)[rowIndex] !== operands[predicateIndex]
        ) {
          return false;
        }

        break;
      case NumericPredicateOperator.NotEqual:
        if (
          !valid ||
          (values[predicateIndex] as NumericArray)[rowIndex] === operands[predicateIndex]
        ) {
          return false;
        }

        break;
      case NumericPredicateOperator.GreaterThan:
        if (
          !valid ||
          !(
            ((values[predicateIndex] as NumericArray)[rowIndex] as number) >
            (operands[predicateIndex] as number)
          )
        ) {
          return false;
        }

        break;
      case NumericPredicateOperator.GreaterThanOrEqual:
        if (
          !valid ||
          !(
            ((values[predicateIndex] as NumericArray)[rowIndex] as number) >=
            (operands[predicateIndex] as number)
          )
        ) {
          return false;
        }

        break;
      case NumericPredicateOperator.LessThan:
        if (
          !valid ||
          !(
            ((values[predicateIndex] as NumericArray)[rowIndex] as number) <
            (operands[predicateIndex] as number)
          )
        ) {
          return false;
        }

        break;
      case NumericPredicateOperator.LessThanOrEqual:
        if (
          !valid ||
          !(
            ((values[predicateIndex] as NumericArray)[rowIndex] as number) <=
            (operands[predicateIndex] as number)
          )
        ) {
          return false;
        }

        break;
      case NumericPredicateOperator.IsNull:
        if (valid) {
          return false;
        }

        break;
      case NumericPredicateOperator.IsNotNull:
        if (!valid) {
          return false;
        }

        break;
      default:
        return false;
    }
  }

  return true;
}

function finalizeSingle(expression: AggregateExpression, state: AggregateState): number | null {
  switch (expression.kind) {
    case 'count':
      return state.count;
    case 'sum':
      return state.count === 0 ? null : state.sum + state.compensation;
    case 'mean':
      return state.count === 0 ? null : state.mean;
    case 'min':
      return state.count === 0 ? null : state.min;
    case 'max':
      return state.count === 0 ? null : state.max;
    case 'variance':
      return state.count === 0 || (expression.sample === true && state.count < 2)
        ? null
        : state.m2 / (state.count - (expression.sample === true ? 1 : 0));
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

function getAggregateOpcode(kind: AggregateKind): AggregateOpcode {
  switch (kind) {
    case 'sum':
      return AggregateOpcode.Sum;
    case 'mean':
      return AggregateOpcode.Mean;
    case 'min':
      return AggregateOpcode.Min;
    case 'max':
      return AggregateOpcode.Max;
    case 'count':
      return AggregateOpcode.Count;
    case 'variance':
      return AggregateOpcode.Variance;
  }
}

function updateState(state: AggregateState, opcode: AggregateOpcode, value: number): void {
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

function finalizeStates(
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

function getColumnValidity(column: Column | undefined): Uint32Array | undefined {
  if (
    column instanceof NumericColumn ||
    column instanceof BooleanColumn ||
    column instanceof DictionaryColumn
  ) {
    return column.validity;
  }

  return undefined;
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
