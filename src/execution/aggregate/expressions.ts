import { AggregateIntent } from '../../core/intents.js';
import type { AggregateExpression } from './types.js';

export function sum(column: string): AggregateExpression {
  return { kind: AggregateIntent.Sum, column };
}

export function mean(column: string): AggregateExpression {
  return { kind: AggregateIntent.Mean, column };
}

export function min(column: string): AggregateExpression {
  return { kind: AggregateIntent.Min, column };
}

export function max(column: string): AggregateExpression {
  return { kind: AggregateIntent.Max, column };
}

export function count(column?: string): AggregateExpression {
  return column === undefined
    ? { kind: AggregateIntent.Count }
    : { kind: AggregateIntent.Count, column };
}

export function variance(column: string, sample = false): AggregateExpression {
  return { kind: AggregateIntent.Variance, column, sample };
}
