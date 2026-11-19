import { describe, expect, it } from 'vitest';
import { value } from '../src/value';

describe('value', () => {
  it('uses the changed value', () => expect(value).toBe(2));
});
