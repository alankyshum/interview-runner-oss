/*
 * SEED AUTHORING CONTRACT — pass
 * GIVEN fields: id.
 * AUTHORED fields:
 * - verdict: the row judgement; TODO means untouched.
 * EXAMPLE (exactly one; excluded from grading):
 * { verdict: "EXAMPLE" }
 */
export type PassRow = {
  /** GIVEN — stable fixture identifier. */
  id: string;
  /** AUTHORED — TODO while untouched; adequate or missing according to the row's evidence. */
  verdict: string;
};
