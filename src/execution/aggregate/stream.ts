import { AbortExecutionError, SchemaError } from '../../core/errors.js';
import { AggregateIntent } from '../../core/intents.js';
import { EXECUTION_CONSTANTS } from '../../core/constants.js';
import type { Predicate } from '../../expressions/predicate.js';
import { compileNumericPredicatePlan } from '../../expressions/numeric-plan.js';
import { NumericColumn } from '../../column/column.js';
import type { Table } from '../../table/table.js';
import type { AggregateExpression, AggregateOptions, AggregateSpec } from './types.js';
import {
  AggregateOpcode,
  createState,
  createStates,
  finalizeStates,
  getAggregateOpcode,
  getColumnValidity,
  isAborted,
  updateState,
  validateAggregateColumn,
  assertAggregateKind,
  type AggregatePlan,
  type AggregateState,
  type NumericAggregateGroup,
} from './internal.js';
import { matchesNumericPredicatePlan } from './single.js';

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
  const chunkPlans: AggregatePlan[] = [];
  const countPlans: AggregatePlan[] = [];
  const numericGroups: NumericAggregateGroup[] = [];
  const numericGroupsByColumn = new Map<string, NumericAggregateGroup>();
  let groupsInitialized = false;
  let initialized = false;

  for (const [, expression] of expressions) {
    assertAggregateKind(expression.kind);

    if (expression.kind !== AggregateIntent.Count && expression.column === undefined) {
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

    for (let planIndex = 0; planIndex < expressions.length; planIndex += 1) {
      const [name, expression] = expressions[planIndex] as [string, AggregateExpression];
      const state = states.get(name);

      if (state === undefined) {
        throw new SchemaError(`Missing aggregate state for '${name}'.`);
      }

      const column = expression.column === undefined ? undefined : chunk.column(expression.column);

      if (column !== undefined) {
        validateAggregateColumn(expression, column.kind);
      }

      const numericColumn = column instanceof NumericColumn ? column : undefined;
      const existingPlan = chunkPlans[planIndex];

      if (existingPlan === undefined) {
        chunkPlans.push({
          opcode: getAggregateOpcode(expression.kind),
          hasColumn: expression.column !== undefined,
          state,
          values: numericColumn?.values,
          validity: getColumnValidity(column),
        });
      } else {
        existingPlan.values = numericColumn?.values;
        existingPlan.validity = getColumnValidity(column);
      }
    }

    if (!groupsInitialized) {
      for (let planIndex = 0; planIndex < expressions.length; planIndex += 1) {
        const plan = chunkPlans[planIndex];
        const expression = expressions[planIndex]?.[1];

        if (plan === undefined || expression === undefined) {
          continue;
        }

        if (plan.opcode === AggregateOpcode.Count) {
          countPlans.push(plan);
          continue;
        }

        if (expression.column === undefined || plan.values === undefined) {
          throw new SchemaError(`Aggregate '${expression.kind}' requires a numeric column.`);
        }

        let group = numericGroupsByColumn.get(expression.column);

        if (group === undefined) {
          group = { values: plan.values, validity: plan.validity, plans: [] };
          numericGroupsByColumn.set(expression.column, group);
          numericGroups.push(group);
        }

        group.plans.push(plan);
      }

      groupsInitialized = true;
    } else {
      for (const group of numericGroups) {
        const firstPlan = group.plans[0];

        if (firstPlan?.values === undefined) {
          throw new SchemaError('Streaming aggregate column changed to a non-numeric type.');
        }

        group.values = firstPlan.values;
        group.validity = firstPlan.validity;
      }
    }

    for (let rowIndex = 0; rowIndex < chunk.rowCount; rowIndex += 1) {
      if (
        (rowIndex & (EXECUTION_CONSTANTS.abortCheckInterval - 1)) === 0 &&
        isAborted(options.signal)
      ) {
        throw new AbortExecutionError();
      }

      if (predicatePlan !== undefined && !matchesNumericPredicatePlan(predicatePlan, rowIndex)) {
        continue;
      }

      if (evaluator !== undefined && !evaluator(rowIndex)) {
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
  }

  if (!initialized) {
    for (const [name] of expressions) {
      states.set(name, createState());
    }
  }

  return finalizeStates(spec, states, expressions);
}
