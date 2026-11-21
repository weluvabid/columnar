import { AbortExecutionError, SchemaError } from '../core/errors.js';
import { AggregateIntent } from '../core/intents.js';
import { EXECUTION_CONSTANTS } from '../core/constants.js';
import type { NumericArray } from '../core/types.js';
import type { Predicate } from '../expressions/predicate.js';
import { compileNumericPredicatePlan } from '../expressions/numeric-plan.js';
import { NumericColumn } from '../column/column.js';
import type { Table } from '../table/table.js';
import type { AggregateOptions, AggregateSpec } from './aggregate/types.js';
import {
  AggregateOpcode,
  assertAggregateKind,
  createStates,
  finalizeSingle,
  finalizeStates,
  getAggregateOpcode,
  getColumnValidity,
  isAborted,
  setResult,
  updateState,
  validateAggregateColumn,
  type AggregatePlan,
  type NumericAggregateGroup,
} from './aggregate/internal.js';
import { aggregateSingleNumeric, matchesNumericPredicatePlan } from './aggregate/single.js';
export { aggregateStream } from './aggregate/stream.js';
export { sum, mean, min, max, count, variance } from './aggregate/expressions.js';
export type {
  AggregateExpression,
  AggregateKind,
  AggregateOptions,
  AggregateSpec,
} from './aggregate/types.js';

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

      if (expression.column === undefined && expression.kind !== AggregateIntent.Count) {
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
  const numericPredicatePlan =
    predicates.length === 0 ? undefined : compileNumericPredicatePlan(predicates, table);
  const evaluators =
    numericPredicatePlan === undefined ? predicates.map((predicate) => predicate.bind(table)) : [];
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
    });
  }

  if (numericPredicatePlan?.alwaysFalse === true) {
    return finalizeStates(spec, states, entries);
  }

  const countPlans: AggregatePlan[] = [];
  const groupsByValues = new Map<
    NumericArray,
    Map<Uint32Array | undefined, NumericAggregateGroup>
  >();

  for (const plan of plans) {
    if (plan.opcode === AggregateOpcode.Count) {
      countPlans.push(plan);
      continue;
    }

    if (plan.values === undefined) {
      continue;
    }

    let groupsByValidity = groupsByValues.get(plan.values);

    if (groupsByValidity === undefined) {
      groupsByValidity = new Map();
      groupsByValues.set(plan.values, groupsByValidity);
    }

    let group = groupsByValidity.get(plan.validity);

    if (group === undefined) {
      group = { values: plan.values, validity: plan.validity, plans: [] };
      groupsByValidity.set(plan.validity, group);
    }

    group.plans.push(plan);
  }

  const numericGroups: NumericAggregateGroup[] = [];

  for (const groupsByValidity of groupsByValues.values()) {
    for (const group of groupsByValidity.values()) {
      numericGroups.push(group);
    }
  }

  for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex += 1) {
    if ((rowIndex & (EXECUTION_CONSTANTS.abortCheckInterval - 1)) === 0 && isAborted(signal)) {
      throw new AbortExecutionError();
    }

    if (
      numericPredicatePlan !== undefined &&
      !matchesNumericPredicatePlan(numericPredicatePlan, rowIndex)
    ) {
      continue;
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

    const validityWord = rowIndex >>> 5;
    const validityMask = 1 << (rowIndex & 31);

    for (let planIndex = 0; planIndex < countPlans.length; planIndex += 1) {
      const plan = countPlans[planIndex];

      if (
        plan !== undefined &&
        (!plan.hasColumn ||
          plan.validity === undefined ||
          ((plan.validity[validityWord] as number) & validityMask) !== 0)
      ) {
        plan.state.count += 1;
      }
    }

    for (let groupIndex = 0; groupIndex < numericGroups.length; groupIndex += 1) {
      const group = numericGroups[groupIndex];

      if (
        group === undefined ||
        (group.validity !== undefined &&
          ((group.validity[validityWord] as number) & validityMask) === 0)
      ) {
        continue;
      }

      const value = group.values[rowIndex] as number;

      for (let planIndex = 0; planIndex < group.plans.length; planIndex += 1) {
        const plan = group.plans[planIndex];

        if (plan !== undefined) {
          updateState(plan.state, plan.opcode, value);
        }
      }
    }
  }

  return finalizeStates(spec, states, entries);
}
