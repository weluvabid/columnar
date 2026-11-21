import { AbortExecutionError } from '../../core/errors.js';
import { AggregateIntent } from '../../core/intents.js';
import { EXECUTION_CONSTANTS } from '../../core/constants.js';
import type { NumericArray } from '../../core/types.js';
import {
  NumericPredicateOperator,
  type NumericPredicatePlan,
} from '../../expressions/numeric-plan.js';
import type { AggregateExpression } from './types.js';
import { createState, type AggregateState } from './internal.js';

export function aggregateSingleNumeric(
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
    kind === AggregateIntent.Sum &&
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
    case AggregateIntent.Sum: {
      let total = 0;
      let compensation = 0;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (
          (rowIndex & (EXECUTION_CONSTANTS.abortCheckInterval - 1)) === 0 &&
          signal?.aborted === true
        ) {
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
    case AggregateIntent.Mean: {
      let average = 0;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (
          (rowIndex & (EXECUTION_CONSTANTS.abortCheckInterval - 1)) === 0 &&
          signal?.aborted === true
        ) {
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
    case AggregateIntent.Min: {
      let minimum = Number.POSITIVE_INFINITY;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (
          (rowIndex & (EXECUTION_CONSTANTS.abortCheckInterval - 1)) === 0 &&
          signal?.aborted === true
        ) {
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
    case AggregateIntent.Max: {
      let maximum = Number.NEGATIVE_INFINITY;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (
          (rowIndex & (EXECUTION_CONSTANTS.abortCheckInterval - 1)) === 0 &&
          signal?.aborted === true
        ) {
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
    case AggregateIntent.Variance: {
      let average = 0;
      let m2 = 0;
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (
          (rowIndex & (EXECUTION_CONSTANTS.abortCheckInterval - 1)) === 0 &&
          signal?.aborted === true
        ) {
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
    case AggregateIntent.Count: {
      let count = 0;

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (
          (rowIndex & (EXECUTION_CONSTANTS.abortCheckInterval - 1)) === 0 &&
          signal?.aborted === true
        ) {
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

  return state;
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
    if (
      (rowIndex & (EXECUTION_CONSTANTS.abortCheckInterval - 1)) === 0 &&
      signal?.aborted === true
    ) {
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

export function matchesNumericPredicatePlan(plan: NumericPredicatePlan, rowIndex: number): boolean {
  if (plan.alwaysFalse) {
    return false;
  }

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
