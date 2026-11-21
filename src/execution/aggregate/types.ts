import type { AggregateIntent } from '../../core/intents.js';

export type AggregateKind = AggregateIntent;

export interface AggregateExpression {
  readonly kind: AggregateKind;
  readonly column?: string;
  readonly sample?: boolean;
}

export type AggregateSpec = Readonly<Record<string, AggregateExpression>>;

export interface AggregateOptions {
  readonly signal?: AbortSignal;
}
