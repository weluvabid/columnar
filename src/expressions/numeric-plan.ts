import type { NumericArray } from '../core/types.js';
import { ComparisonIntent, PredicateNodeIntent } from '../core/intents.js';
import { isNumberValue } from '../core/value-guards.js';
import { NumericColumn } from '../column/column.js';
import type { Table } from '../table/table.js';
import type { PredicateNode } from './predicate-types.js';
import type { Predicate } from './predicate.js';

export const NumericPredicateOperator = {
  Equal: 0,
  NotEqual: 1,
  GreaterThan: 2,
  GreaterThanOrEqual: 3,
  LessThan: 4,
  LessThanOrEqual: 5,
  IsNull: 6,
  IsNotNull: 7,
} as const;

export interface NumericPredicatePlan {
  readonly values: readonly NumericArray[];
  readonly validity: readonly (Uint32Array | undefined)[];
  readonly operators: Uint8Array;
  readonly operands: Float64Array;
  readonly alwaysFalse: boolean;
}

const EMPTY_NUMERIC_PREDICATE_PLAN: NumericPredicatePlan = {
  values: [],
  validity: [],
  operators: new Uint8Array(0),
  operands: new Float64Array(0),
  alwaysFalse: false,
};

export function compileNumericPredicatePlan(
  predicates: readonly Predicate[],
  table: Table,
): NumericPredicatePlan | undefined {
  if (predicates.length === 0) {
    return EMPTY_NUMERIC_PREDICATE_PLAN;
  }

  const values: NumericArray[] = [];
  const validity: (Uint32Array | undefined)[] = [];
  const operators: number[] = [];
  const operands: number[] = [];
  let alwaysFalse = false;

  const append = (node: PredicateNode): boolean => {
    if (node.type === PredicateNodeIntent.And) {
      return append(node.left) && append(node.right);
    }

    if (node.type === PredicateNodeIntent.Comparison) {
      const column = table.column(node.column);

      if (!(column instanceof NumericColumn)) {
        return false;
      }

      if (node.value === null) {
        alwaysFalse = true;

        return true;
      }

      if (!isNumberValue(node.value)) {
        return false;
      }

      values.push(column.values);
      validity.push(column.validity);
      operands.push(node.value);

      switch (node.operator) {
        case ComparisonIntent.Equal:
          operators.push(NumericPredicateOperator.Equal);
          break;
        case ComparisonIntent.NotEqual:
          operators.push(NumericPredicateOperator.NotEqual);
          break;
        case ComparisonIntent.GreaterThan:
          operators.push(NumericPredicateOperator.GreaterThan);
          break;
        case ComparisonIntent.GreaterThanOrEqual:
          operators.push(NumericPredicateOperator.GreaterThanOrEqual);
          break;
        case ComparisonIntent.LessThan:
          operators.push(NumericPredicateOperator.LessThan);
          break;
        case ComparisonIntent.LessThanOrEqual:
          operators.push(NumericPredicateOperator.LessThanOrEqual);
          break;
      }

      return true;
    }

    if (node.type === PredicateNodeIntent.Null) {
      const column = table.column(node.column);

      if (!(column instanceof NumericColumn)) {
        return false;
      }

      values.push(column.values);
      validity.push(column.validity);
      operands.push(0);
      operators.push(
        node.negate ? NumericPredicateOperator.IsNotNull : NumericPredicateOperator.IsNull,
      );

      return true;
    }

    return false;
  };

  for (const predicate of predicates) {
    if (!append(predicate.node)) {
      return undefined;
    }
  }

  return {
    values,
    validity,
    operators: Uint8Array.from(operators),
    operands: Float64Array.from(operands),
    alwaysFalse,
  };
}
