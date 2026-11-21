import type { Scalar } from '../core/types.js';
import type { PredicateNodeIntent } from '../core/intents.js';
import { type ComparisonIntent } from '../core/intents.js';

export type ComparisonOperator = ComparisonIntent;

export type PredicateNode =
  | {
      readonly type: typeof PredicateNodeIntent.Comparison;
      readonly column: string;
      readonly operator: ComparisonOperator;
      readonly value: Scalar;
    }
  | {
      readonly type: typeof PredicateNodeIntent.Null;
      readonly column: string;
      readonly negate: boolean;
    }
  | {
      readonly type: typeof PredicateNodeIntent.And | typeof PredicateNodeIntent.Or;
      readonly left: PredicateNode;
      readonly right: PredicateNode;
    }
  | {
      readonly type: typeof PredicateNodeIntent.Not;
      readonly expression: PredicateNode;
    };
