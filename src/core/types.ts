export type Scalar = number | string | boolean | null;

export type NumericArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export type ColumnInput = NumericArray | readonly (Scalar | undefined)[];

export type Row = Record<string, Scalar | undefined>;
