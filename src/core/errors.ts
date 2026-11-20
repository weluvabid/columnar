export class ColumnarError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);

    this.name = new.target.name;
  }
}

export class SchemaError extends ColumnarError {}

export class ExecutionError extends ColumnarError {}

export class AbortExecutionError extends ColumnarError {
  constructor() {
    super('Columnar execution was aborted.');
  }
}
