import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function statePath(): string {
  // RUNNER_DB_PATH is the single user database of a self-hosted stack; without it the legacy progress.db next to the package is used.
  return process.env.VITEST ? ':memory:' : process.env.RUNNER_DB_PATH || join(fileURLToPath(new URL('..', import.meta.url)), 'progress.db');
}
