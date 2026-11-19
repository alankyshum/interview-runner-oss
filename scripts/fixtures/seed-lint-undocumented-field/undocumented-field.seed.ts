/*
 * SEED AUTHORING CONTRACT — undocumented-field
 * GIVEN fields: id.
 * AUTHORED fields:
 * - verdict: the row judgement.
 * EXAMPLE (exactly one; excluded from grading):
 * { verdict: "EXAMPLE" }
 */
export type UndocumentedRow = {
  /** GIVEN — stable fixture identifier. */
  id: string;
  verdict: string;
};
