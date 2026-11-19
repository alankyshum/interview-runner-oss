import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const checker = `${root}/scripts/lint-seeds.ts`;
const fixture = (name: string) => `${root}/scripts/fixtures/${name}`;
const tsx = `${root}/node_modules/.bin/tsx`;

function run(name: string): { status: number; output: string } {
  try {
    return { status: 0, output: execFileSync(tsx, [checker, fixture(name)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    const result = error as { status: number; stdout?: string; stderr?: string };
    return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }
}

describe('seed lint gate', () => {
  it('accepts a documented seed with a contract header', () => {
    const result = run('seed-lint-pass');
    expect(result.status).toBe(0);
    expect(result.output).toContain('Seed lint passed');
  });

  it('rejects a seed without the contract header', () => {
    const result = run('seed-lint-missing-header');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('missing exactly one SEED AUTHORING CONTRACT header');
  });

  it('rejects an undocumented exported record field', () => {
    const result = run('seed-lint-undocumented-field');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("field 'verdict' on type 'UndocumentedRow' has no doc comment");
  });
});
