export class ContentValidationError extends Error {
  constructor(public errors: Array<{ field: string; message: string }>) { super('Content validation failed'); }
}
