import type { Scalar } from '../core/types.js';
import { NumericColumn } from '../column/column.js';
import { isValid } from '../memory/validity.js';
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
    const evaluator = compile(this.node, table);

    return (rowIndex) => evaluator(rowIndex);
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

function compile(node: PredicateNode, table: Table): BoundPredicate {
  switch (node.type) {
    case 'comparison': {
      const column = table.column(node.column);
      const right = node.value;

      if (right === null) {
        return () => false;
      }

      if (column instanceof NumericColumn && typeof right === 'number') {
        const values = column.values;
        const validity = column.validity;

        switch (node.operator) {
          case 'eq':
            return (rowIndex) => {
              const valid = validity === undefined || isValid(validity, rowIndex);

              return valid && values[rowIndex] === right;
            };
          case 'ne':
            return (rowIndex) => {
              const valid = validity === undefined || isValid(validity, rowIndex);

              return valid && values[rowIndex] !== right;
            };
          case 'gt':
            return (rowIndex) => {
              const valid = validity === undefined || isValid(validity, rowIndex);

              return valid && (values[rowIndex] ?? 0) > right;
            };
          case 'gte':
            return (rowIndex) => {
              const valid = validity === undefined || isValid(validity, rowIndex);

              return valid && (values[rowIndex] ?? 0) >= right;
            };
          case 'lt':
            return (rowIndex) => {
              const valid = validity === undefined || isValid(validity, rowIndex);

              return valid && (values[rowIndex] ?? 0) < right;
            };
          case 'lte':
            return (rowIndex) => {
              const valid = validity === undefined || isValid(validity, rowIndex);

              return valid && (values[rowIndex] ?? 0) <= right;
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
