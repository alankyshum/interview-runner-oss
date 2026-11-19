/// <reference types="vitest/config" />
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import apiPlugin from './server/apiPlugin';
import { stateProxyForOrigin } from './server/stateProxy';
import { courseRepos } from './server/courseRepos';
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import sirv from 'sirv';

function excalidrawAssets(): Plugin {
  const root = resolve('node_modules/@excalidraw/excalidraw/dist/prod');
  let patchedWorker = false;
  return {
    name: 'excalidraw-assets',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/@excalidraw/excalidraw/dist/prod/') || !code.includes('import("./subset-worker.chunk.js")')) return null;
      patchedWorker = true;
      // The upstream worker's shared chunk is worker-safe, but bundling it into
      // the application graph makes Rolldown import DOM-dependent app modules.
      return code.replace('import("./subset-worker.chunk.js")', 'import(/* @vite-ignore */ "/excalidraw-assets/subset-worker.chunk.js")');
    },
    configureServer(server) { server.middlewares.use('/excalidraw-assets', sirv(root)); },
    async writeBundle(options) {
      if (!patchedWorker) throw new Error('Excalidraw subset worker import was not isolated');
      const output = resolve(options.dir ?? 'dist', 'excalidraw-assets');
      await cp(resolve(root, 'fonts'), resolve(output, 'fonts'), { recursive: true });
      for (const file of ['subset-worker.chunk.js', 'chunk-EIO257PC.js', 'chunk-ZUYEQ4TG.js', 'chunk-SRAX5OIU.js']) await cp(resolve(root, file), resolve(output, file));
    },
  };
}

const developmentEnv = loadEnv('development', process.cwd(), '');
const developmentStateOrigin = stateProxyForOrigin(developmentEnv.INTERVIEW_RUNNER_STATE_ORIGIN);
process.env.RUNNER_SANDBOX_DRIVER ??= developmentEnv.RUNNER_SANDBOX_DRIVER || 'local';

export default defineConfig({
  // Tests run only from explicit Run/Submit actions; saving never starts Vitest.
  plugins: [react(), excalidrawAssets(), apiPlugin({ enableDeterministicWatchers: false, remoteStateOrigin: developmentStateOrigin })],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { manifest: true },
  server: {
    // The dev script owns the bind address. To reach the dev server by another name, list the
    // hosts (a leading dot matches a whole domain) in RUNNER_DEV_ALLOWED_HOSTS, comma-separated.
    allowedHosts: (developmentEnv.RUNNER_DEV_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean),
    port: 5173,
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), ...courseRepos.map((repo) => repo.root)] },
  },
  test: {
    // Existing file-backed integration fixtures opt in explicitly; DB suites set
    // their own mode and database after isolating their link state.
    env: { INTERVIEW_RUNNER_CONTENT_SOURCE: 'files' },
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'scripts/**/*.test.ts', ...courseRepos.map((repo) => `${repo.root}/drills/**/*.test.{ts,tsx}`)],
    exclude: ['server/fixtures/**', 'scripts/fixtures/**'],
    // Cold-starting a jsdom worker and importing Mantine costs ~20-30s of shared
    // module work, which lands inside the first test of each file when workers run
    // in parallel. The 5s default times out on that startup rather than on any real
    // assertion, so give the first render room; drills keep their own fast feedback.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
