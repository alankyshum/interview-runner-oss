// Local staging: the dev server with your linked courses but throwaway state.
// Progress, highlights and map state live in memory and vanish on stop;
// sandbox workspaces and Git history go to a temporary state directory.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const realState = process.env.XDG_STATE_HOME ? resolve(process.env.XDG_STATE_HOME) : join(homedir(), '.local/state');
const stagingState = resolve(process.env.STAGING_STATE_DIR ?? join(tmpdir(), 'interview-runner-staging'));
const port = process.env.STAGING_PORT ?? '5198';

if (stagingState === realState) {
  console.error(`staging: STAGING_STATE_DIR must differ from your real state directory (${realState}).`);
  process.exit(1);
}

// Copy the current course links so staging shows the same courses as local dev.
const realLinks = join(realState, 'interview-runner/links.json');
mkdirSync(join(stagingState, 'interview-runner'), { recursive: true });
if (existsSync(realLinks)) copyFileSync(realLinks, join(stagingState, 'interview-runner/links.json'));
else console.warn(`staging: no course links at ${realLinks}; link a course repository first.`);

const env = {
  ...process.env,
  XDG_STATE_HOME: stagingState,
  VITEST: '1', // in-memory progress.db and content.db (server/statePath.ts, server/content/contentDb.ts)
  INTERVIEW_RUNNER_CONTENT_SOURCE: 'files',
  INTERVIEW_RUNNER_STATE_ORIGIN: '',
  RUNNER_SANDBOX_DRIVER: 'local',
};

console.log(`staging: http://127.0.0.1:${port}/ (state: ${stagingState})`);
const child = spawn(
  join('node_modules', '.bin', 'vite'),
  ['--host', '127.0.0.1', '--port', port, '--strictPort', '--configLoader', 'runner', ...process.argv.slice(2)],
  { stdio: 'inherit', env },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
