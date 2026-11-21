import { ComparisonIntent, PredicateNodeIntent } from '../core/intents.js';
import { SchemaError } from '../core/errors.js';
import type { Scalar } from '../core/types.js';
import type { Table } from '../table/table.js';
import type { ComparisonOperator, PredicateNode } from './predicate-types.js';
import { compilePredicate } from './predicate-compiler.js';

export type { ComparisonOperator } from './predicate-types.js';
export { compileNumericPredicatePlan, NumericPredicateOperator } from './numeric-plan.js';
export type { NumericPredicatePlan } from './numeric-plan.js';

export class Predicate {
  constructor(readonly node: PredicateNode) {}

  and(other: Predicate): Predicate {
    return new Predicate({ type: PredicateNodeIntent.And, left: this.node, right: other.node });
  }

  or(other: Predicate): Predicate {
    return new Predicate({ type: PredicateNodeIntent.Or, left: this.node, right: other.node });
  }

  not(): Predicate {
    return new Predicate({ type: PredicateNodeIntent.Not, expression: this.node });
  }

  bind(table: Table): (rowIndex: number) => boolean {
    return compilePredicate(this.node, table);
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
    return this.compare(ComparisonIntent.Equal, value);
  }

  ne(value: Scalar): Predicate {
    return this.compare(ComparisonIntent.NotEqual, value);
  }

  gt(value: number): Predicate {
    return this.compare(ComparisonIntent.GreaterThan, value);
  }

  gte(value: number): Predicate {
    return this.compare(ComparisonIntent.GreaterThanOrEqual, value);
  }

  lt(value: number): Predicate {
    return this.compare(ComparisonIntent.LessThan, value);
  }

  lte(value: number): Predicate {
    return this.compare(ComparisonIntent.LessThanOrEqual, value);
  }

  isNull(): Predicate {
    return new Predicate({ type: PredicateNodeIntent.Null, column: this.name, negate: false });
  }

  isNotNull(): Predicate {
    return new Predicate({ type: PredicateNodeIntent.Null, column: this.name, negate: true });
  }

  private compare(operator: ComparisonOperator, value: Scalar): Predicate {
    return new Predicate({
      type: PredicateNodeIntent.Comparison,
      column: this.name,
      operator,
      value,
    });
  }
}

export function col(name: string): ColumnExpression {
  return new ColumnExpression(name);
}
