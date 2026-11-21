import { ValueKindIntent } from './intents.js';

export function isNumberValue(value: unknown): value is number {
  return typeof value === ValueKindIntent.Number;
}

export function isStringValue(value: unknown): value is string {
  return typeof value === ValueKindIntent.String;
}

export function isBooleanValue(value: unknown): value is boolean {
  return typeof value === ValueKindIntent.Boolean;
}
