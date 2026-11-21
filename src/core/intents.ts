export const ColumnKindIntent = {
  Int8: 'int8',
  Uint8: 'uint8',
  Int16: 'int16',
  Uint16: 'uint16',
  Int32: 'int32',
  Uint32: 'uint32',
  Float32: 'float32',
  Float64: 'float64',
  Boolean: 'boolean',
  Dictionary: 'dictionary',
} as const;

export type ColumnKindIntent = (typeof ColumnKindIntent)[keyof typeof ColumnKindIntent];

export const PredicateNodeIntent = {
  Comparison: 'comparison',
  Null: 'null',
  And: 'and',
  Or: 'or',
  Not: 'not',
} as const;

export const ComparisonIntent = {
  Equal: 'eq',
  NotEqual: 'ne',
  GreaterThan: 'gt',
  GreaterThanOrEqual: 'gte',
  LessThan: 'lt',
  LessThanOrEqual: 'lte',
} as const;

export type ComparisonIntent = (typeof ComparisonIntent)[keyof typeof ComparisonIntent];

export const AggregateIntent = {
  Sum: 'sum',
  Mean: 'mean',
  Min: 'min',
  Max: 'max',
  Count: 'count',
  Variance: 'variance',
} as const;

export type AggregateIntent = (typeof AggregateIntent)[keyof typeof AggregateIntent];

export const ValueKindIntent = {
  Number: 'number',
  String: 'string',
  Boolean: 'boolean',
} as const;

export type ValueKindIntent = (typeof ValueKindIntent)[keyof typeof ValueKindIntent];
