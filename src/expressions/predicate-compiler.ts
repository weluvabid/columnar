import { BooleanColumn, DictionaryColumn, NumericColumn } from '../column/column.js';
import { ComparisonIntent, PredicateNodeIntent } from '../core/intents.js';
import { isBooleanValue, isNumberValue, isStringValue } from '../core/value-guards.js';
import type { Table } from '../table/table.js';
import type { PredicateNode } from './predicate-types.js';

type BoundPredicate = (rowIndex: number) => boolean;

export function compilePredicate(node: PredicateNode, table: Table): BoundPredicate {
  return compilePredicateNode(node, table);
}

function compilePredicateNode(node: PredicateNode, table: Table): BoundPredicate {
  switch (node.type) {
    case PredicateNodeIntent.Comparison: {
      const column = table.column(node.column);
      const right = node.value;

      if (right === null) {
        return () => false;
      }

      if (column instanceof DictionaryColumn && isStringValue(right)) {
        const dictionaryIndex = column.dictionary.indexOf(right);
        const indices = column.indices;
        const validity = column.validity;

        if (node.operator === ComparisonIntent.Equal) {
          if (dictionaryIndex === -1) {
            return () => false;
          }

          return (rowIndex) =>
            (validity === undefined ||
              ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0) &&
            indices[rowIndex] === dictionaryIndex;
        }

        if (node.operator === ComparisonIntent.NotEqual) {
          if (dictionaryIndex === -1) {
            return (rowIndex) =>
              validity === undefined ||
              ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;
          }

          return (rowIndex) =>
            (validity === undefined ||
              ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0) &&
            indices[rowIndex] !== dictionaryIndex;
        }

        return () => false;
      }

      if (column instanceof BooleanColumn && isBooleanValue(right)) {
        const values = column.values;
        const validity = column.validity;
        const expected = right ? 1 : 0;

        if (node.operator === ComparisonIntent.Equal) {
          return (rowIndex) =>
            (validity === undefined ||
              ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0) &&
            values[rowIndex] === expected;
        }

        if (node.operator === ComparisonIntent.NotEqual) {
          return (rowIndex) =>
            (validity === undefined ||
              ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0) &&
            values[rowIndex] !== expected;
        }

        return () => false;
      }

      if (column instanceof NumericColumn && isNumberValue(right)) {
        const values = column.values;
        const validity = column.validity;

        switch (node.operator) {
          case ComparisonIntent.Equal:
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && values[rowIndex] === right;
            };
          case ComparisonIntent.NotEqual:
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && values[rowIndex] !== right;
            };
          case ComparisonIntent.GreaterThan:
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && (values[rowIndex] as number) > right;
            };
          case ComparisonIntent.GreaterThanOrEqual:
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && (values[rowIndex] as number) >= right;
            };
          case ComparisonIntent.LessThan:
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && (values[rowIndex] as number) < right;
            };
          case ComparisonIntent.LessThanOrEqual:
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && (values[rowIndex] as number) <= right;
            };
        }
      }

      return (rowIndex) => {
        const left = column.getUnchecked(rowIndex);

        if (left === null) {
          return false;
        }

        switch (node.operator) {
          case ComparisonIntent.Equal:
            return left === right;
          case ComparisonIntent.NotEqual:
            return left !== right;
          case ComparisonIntent.GreaterThan:
            return isNumberValue(left) && isNumberValue(right) && left > right;
          case ComparisonIntent.GreaterThanOrEqual:
            return isNumberValue(left) && isNumberValue(right) && left >= right;
          case ComparisonIntent.LessThan:
            return isNumberValue(left) && isNumberValue(right) && left < right;
          case ComparisonIntent.LessThanOrEqual:
            return isNumberValue(left) && isNumberValue(right) && left <= right;
        }
      };
    }
    case PredicateNodeIntent.Null: {
      const column = table.column(node.column);

      if (
        column instanceof NumericColumn ||
        column instanceof BooleanColumn ||
        column instanceof DictionaryColumn
      ) {
        const validity = column.validity;

        if (validity === undefined) {
          return () => node.negate;
        }

        return (rowIndex) =>
          (((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) === 0) !== node.negate;
      }

      return (rowIndex) => (column.getUnchecked(rowIndex) === null) !== node.negate;
    }
    case PredicateNodeIntent.And: {
      const left = compilePredicateNode(node.left, table);
      const right = compilePredicateNode(node.right, table);

      return (rowIndex) => left(rowIndex) && right(rowIndex);
    }
    case PredicateNodeIntent.Or: {
      const left = compilePredicateNode(node.left, table);
      const right = compilePredicateNode(node.right, table);

      return (rowIndex) => left(rowIndex) || right(rowIndex);
    }
    case PredicateNodeIntent.Not: {
      const expression = compilePredicateNode(node.expression, table);

      return (rowIndex) => !expression(rowIndex);
    }
  }
}
