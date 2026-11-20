import type { NumericArray, Scalar } from '../core/types.js';
import { BooleanColumn, DictionaryColumn, NumericColumn } from '../column/column.js';
import { SchemaError } from '../core/errors.js';
import type { Table } from '../table/table.js';

export type ComparisonOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

type PredicateNode =
  | {
      readonly type: 'comparison';
      readonly column: string;
      readonly operator: ComparisonOperator;
      readonly value: Scalar;
    }
  | { readonly type: 'null'; readonly column: string; readonly negate: boolean }
  | { readonly type: 'and' | 'or'; readonly left: PredicateNode; readonly right: PredicateNode }
  | { readonly type: 'not'; readonly expression: PredicateNode };

export class Predicate {
  constructor(readonly node: PredicateNode) {}

  and(other: Predicate): Predicate {
    return new Predicate({ type: 'and', left: this.node, right: other.node });
  }

  or(other: Predicate): Predicate {
    return new Predicate({ type: 'or', left: this.node, right: other.node });
  }

  not(): Predicate {
    return new Predicate({ type: 'not', expression: this.node });
  }

  bind(table: Table): (rowIndex: number) => boolean {
    return compile(this.node, table);
  }

  matches(table: Table, rowIndex: number): boolean {
    return this.bind(table)(rowIndex);
  }
}

export class ColumnExpression {
  constructor(readonly name: string) {
    if (name.length === 0) {
      throw new SchemaError('Column expression names cannot be empty.');
    }
  }

  eq(value: Scalar): Predicate {
    return this.compare('eq', value);
  }

  ne(value: Scalar): Predicate {
    return this.compare('ne', value);
  }

  gt(value: number): Predicate {
    return this.compare('gt', value);
  }

  gte(value: number): Predicate {
    return this.compare('gte', value);
  }

  lt(value: number): Predicate {
    return this.compare('lt', value);
  }

  lte(value: number): Predicate {
    return this.compare('lte', value);
  }

  isNull(): Predicate {
    return new Predicate({ type: 'null', column: this.name, negate: false });
  }

  isNotNull(): Predicate {
    return new Predicate({ type: 'null', column: this.name, negate: true });
  }

  private compare(operator: ComparisonOperator, value: Scalar): Predicate {
    return new Predicate({ type: 'comparison', column: this.name, operator, value });
  }
}

export function col(name: string): ColumnExpression {
  return new ColumnExpression(name);
}

type BoundPredicate = (rowIndex: number) => boolean;

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
    if (node.type === 'and') {
      return append(node.left) && append(node.right);
    }

    if (node.type === 'comparison') {
      const column = table.column(node.column);

      if (!(column instanceof NumericColumn)) {
        return false;
      }

      if (node.value === null) {
        alwaysFalse = true;

        return true;
      }

      if (typeof node.value !== 'number') {
        return false;
      }

      values.push(column.values);
      validity.push(column.validity);
      operands.push(node.value);

      switch (node.operator) {
        case 'eq':
          operators.push(NumericPredicateOperator.Equal);
          break;
        case 'ne':
          operators.push(NumericPredicateOperator.NotEqual);
          break;
        case 'gt':
          operators.push(NumericPredicateOperator.GreaterThan);
          break;
        case 'gte':
          operators.push(NumericPredicateOperator.GreaterThanOrEqual);
          break;
        case 'lt':
          operators.push(NumericPredicateOperator.LessThan);
          break;
        case 'lte':
          operators.push(NumericPredicateOperator.LessThanOrEqual);
          break;
      }

      return true;
    }

    if (node.type === 'null') {
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

function compile(node: PredicateNode, table: Table): BoundPredicate {
  switch (node.type) {
    case 'comparison': {
      const column = table.column(node.column);
      const right = node.value;

      if (right === null) {
        return () => false;
      }

      if (column instanceof DictionaryColumn && typeof right === 'string') {
        const dictionaryIndex = column.dictionary.indexOf(right);
        const indices = column.indices;
        const validity = column.validity;

        if (node.operator === 'eq') {
          if (dictionaryIndex === -1) {
            return () => false;
          }

          return (rowIndex) =>
            (validity === undefined ||
              ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0) &&
            indices[rowIndex] === dictionaryIndex;
        }

        if (node.operator === 'ne') {
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

      if (column instanceof BooleanColumn && typeof right === 'boolean') {
        const values = column.values;
        const validity = column.validity;
        const expected = right ? 1 : 0;

        if (node.operator === 'eq') {
          return (rowIndex) =>
            (validity === undefined ||
              ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0) &&
            values[rowIndex] === expected;
        }

        if (node.operator === 'ne') {
          return (rowIndex) =>
            (validity === undefined ||
              ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0) &&
            values[rowIndex] !== expected;
        }

        return () => false;
      }

      if (column instanceof NumericColumn && typeof right === 'number') {
        const values = column.values;
        const validity = column.validity;

        switch (node.operator) {
          case 'eq':
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && values[rowIndex] === right;
            };
          case 'ne':
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && values[rowIndex] !== right;
            };
          case 'gt':
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && (values[rowIndex] as number) > right;
            };
          case 'gte':
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && (values[rowIndex] as number) >= right;
            };
          case 'lt':
            return (rowIndex) => {
              const valid =
                validity === undefined ||
                ((validity[rowIndex >>> 5] as number) & (1 << (rowIndex & 31))) !== 0;

              return valid && (values[rowIndex] as number) < right;
            };
          case 'lte':
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
          case 'eq':
            return left === right;
          case 'ne':
            return left !== right;
          case 'gt':
            return typeof left === 'number' && typeof right === 'number' && left > right;
          case 'gte':
            return typeof left === 'number' && typeof right === 'number' && left >= right;
          case 'lt':
            return typeof left === 'number' && typeof right === 'number' && left < right;
          case 'lte':
            return typeof left === 'number' && typeof right === 'number' && left <= right;
        }
      };
    }
    case 'null': {
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
    case 'and': {
      const left = compile(node.left, table);
      const right = compile(node.right, table);

      return (rowIndex) => left(rowIndex) && right(rowIndex);
    }
    case 'or': {
      const left = compile(node.left, table);
      const right = compile(node.right, table);

      return (rowIndex) => left(rowIndex) || right(rowIndex);
    }
    case 'not': {
      const expression = compile(node.expression, table);

      return (rowIndex) => !expression(rowIndex);
    }
  }
}
