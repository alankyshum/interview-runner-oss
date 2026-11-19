import { defineConfig } from 'vitest/config';
import { transform } from 'esbuild';

const tools = process.env.IR_TOOLS ?? '/opt/ir/tools';

export default defineConfig({
  root: process.env.IR_WORKSPACE,
  cacheDir: process.env.IR_VITE_CACHE,
  plugins: [{ name: 'drills-lower-typescript', enforce: 'pre', async transform(code, id) { if (!/\.tsx?(\?|$)/.test(id)) return null; const output = await transform(code, { loader: /\.tsx(?:\?|$)/.test(id) ? 'tsx' : 'ts', jsx: 'automatic', target: 'es2022', sourcefile: id, sourcemap: true }); return { code: output.code, map: output.map }; } }],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.jsx', '.ir-acceptance/*.test.ts', '.ir-acceptance/*.test.tsx'],
    exclude: ['**/node_modules/**'],
    setupFiles: [`${tools}/setupTests.ts`],
  },
});
