import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';

describe('runner image contract', () => {
  it('installs Git in the deployed runner stage', async () => {
    const source = await readFile('Containerfile', 'utf8');
    const runner = source.split(/^FROM /m).find((stage) => stage.startsWith('node-runtime AS runner\n')) ?? '';
    expect(runner).toMatch(/apt-get install -y --no-install-recommends git\b/);
  });

  it('creates /app through the chowned copy before running commands there', async () => {
    const source = await readFile('Containerfile', 'utf8');
    const runner = source.split(/^FROM /m).find((stage) => stage.startsWith('node-runtime AS runner\n')) ?? '';
    expect(runner).toMatch(/^WORKDIR \/app\s*\nCOPY --from=build --chown=node:node \/app \/app\s*$/m);
  });

  it('builds the client before startup without copying host data or bindings', async () => {
    const source = await readFile('Containerfile', 'utf8');
    const build = source.split(/^FROM /m).find((stage) => stage.startsWith('node-runtime AS build\n')) ?? '';
    const runner = source.split(/^FROM /m).find((stage) => stage.startsWith('node-runtime AS runner\n')) ?? '';
    expect(build).toContain('INTERVIEW_RUNNER_CONTENT_SOURCE=db VITEST=1 npm run build:client');
    expect(build).toContain('courses:{}');
    expect(build).toContain('rm -rf /tmp/ir-client-build');
    expect(build).toContain('npm run build:server');
    expect(runner).toContain('CMD ["node", "server-dist/start.mjs"]');
    expect(runner).not.toContain('vite build');
    const compose = await readFile('compose.yaml', 'utf8');
    expect(compose).toContain('command: ["node", "server-dist/sandboxd.mjs"]');
    expect(compose.split('  sandboxd:')[0]).toContain('mem_limit: 512m');
    const ignore = await readFile('.containerignore', 'utf8');
    for (const path of ['.env*', 'progress.db*', 'content.db*', '.state', 'server-dist', 'course-repos.links.json', 'course-repos.sandbox.json', 'docs', '*.md', '.agents', 'public/test-results.json', 'scripts/deploy-on-push.mjs', 'scripts/smoke-course.mjs', 'scripts/selfhost-cutover', 'scripts/parity', '**/fixtures', '**/*.test.ts']) expect(ignore.split(/\r?\n/)).toContain(path);
  });
});

describe('Python container toolchain contract', () => {
  it('pins uv by digest and keeps uv executables out of the final image', async () => {
    const source = await readFile('Containerfile', 'utf8');
    expect(source).toMatch(/FROM ghcr\.io\/astral-sh\/uv@sha256:[0-9a-f]{64} AS uv/);
    expect(source).toContain('AS python-tools');
    expect(source).toContain('uv python install --no-bin 3.12.12');
    expect(source).toContain('UV_TOOL_BIN_DIR=/opt/bin PATH=/opt/bin:$PATH');
    const finalStage = source.split(/^FROM /m).at(-1) ?? '';
    expect(finalStage).toContain('COPY --from=python-tools /opt/python /opt/python');
    expect(finalStage).toContain('COPY --from=python-tools /opt/uv-tools /opt/uv-tools');
    expect(finalStage).not.toMatch(/COPY --from=uv |\/usr\/local\/bin\/uvx?\b|RUN uv\b/);
  });
});

describe('sandbox image contract', () => {
  it('uses the explicit Vite module runner for both build entry points', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts.build).toContain('npm run build:client');
    expect(manifest.scripts['build:client']).toContain('vite build --configLoader runner');
    expect(manifest.scripts['build:client']).toContain('check-excalidraw-worker.mjs');
    expect(manifest.scripts['build:client']).toContain('compress-client.mjs');
    for (const name of ['dev', 'test', 'test:ui', 'test:json', 'test:run', 'test:runner']) expect(manifest.scripts[name]).toContain('--configLoader runner');
  });
  it('pins code-server and every extension from the validated spike', async () => {
    const source = await readFile('Containerfile', 'utf8');
    expect(source).toContain('docker.io/codercom/code-server@sha256:377b66bec5645510ed52549bb00e648c273edc604d230a3f90fd2b2433afcb97 AS sandbox');
    expect(source).toContain('LABEL io.interview-runner.sandbox="1"');
    expect(source).toContain("code-server --help | grep -q -- '--reconnection-grace-time'");
    for (const extension of ['ms-python.python@2026.4.0', 'detachhead.basedpyright@1.40.2', 'charliermarsh.ruff@2026.90.0', 'ms-vscode.atom-keybindings@3.3.0', 'esbenp.prettier-vscode@12.4.0']) expect(source).toContain(extension);
    expect(source).not.toContain('vitest.explorer');
    expect(source).toContain('FROM node-runtime AS sandbox-deps');
    expect(source).not.toContain('--platform=');
    expect(source).toContain("grep -q -- '--reconnection-grace-time' \\\n    && rm -rf /root/.config /root/.local");
    expect(source).toContain(' AS extensions\nARG TARGETARCH\n');
    expect(source).toContain('arm64) platform=linux-arm64; sha256=f09f90d0ad861f320682b4ea4ca3ea507866e2837aface4beec63823a5d61b09 ;;');
    expect(source).toContain('amd64) platform=linux-x64; sha256=d91b7c182e16c272e46c52d07b3ea8b1ef146ac5cc2a56ee0dcc00bd55586780 ;;');
    expect(source).toContain('*) echo "Unsupported TypeScript native-preview architecture: $TARGETARCH" >&2; exit 1 ;;');
    expect(source.match(/https:\/\/marketplace\.visualstudio\.com\/_apis\/public\/gallery\/publishers\/TypeScriptTeam\/vsextensions\/native-preview\/1\.0\.1\/vspackage[^"'\s]*/g)).toEqual([
      'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/TypeScriptTeam/vsextensions/native-preview/1.0.1/vspackage?targetPlatform=$platform',
    ]);
    expect(source).toContain('echo "$sha256  /tmp/ts7.vsix" | sha256sum -c -');
    expect(source).toContain('npm ci --ignore-scripts');
    expect(source).toContain('COPY sandbox/settings.json /opt/ir/settings.json');
    expect(source).toContain('COPY sandbox/keybindings.json /opt/ir/keybindings.json');
    expect(source).toContain('sandbox/vitest.drills.config.mts');
    expect(source).not.toContain('sandbox/vitest.drills.config.ts');
  });

  it('ships the focused editor preferences and built-in keybindings', async () => {
    const settings = JSON.parse(await readFile('sandbox/settings.json', 'utf8')) as Record<string, unknown>;
    expect(settings).toMatchObject({
      'window.autoDetectColorScheme': true,
      'workbench.preferredLightColorTheme': 'Light Modern',
      'workbench.preferredDarkColorTheme': 'Dark Modern',
      'editor.tabSize': 2,
      'editor.wordWrap': 'on',
      'editor.wordWrapColumn': 120,
      'editor.minimap.enabled': false,
      'diffEditor.renderSideBySideInlineBreakpoint': 900,
      'diffEditor.ignoreTrimWhitespace': true,
      'files.autoSaveDelay': 750,
      'terminal.integrated.gpuAcceleration': 'off',
      'chat.disableAIFeatures': true,
      'git.enabled': true,
      'multiDiffEditor.experimental.fileList': true,
    });
    expect(settings).not.toHaveProperty('workbench.colorTheme');
    expect(settings['[python]']).toMatchObject({ 'editor.defaultFormatter': 'charliermarsh.ruff', 'editor.formatOnSave': true });
    expect(settings['[typescript]']).toMatchObject({ 'editor.defaultFormatter': 'esbenp.prettier-vscode', 'typescript.format.semicolons': 'remove' });

    const keybindings = parse(await readFile('sandbox/keybindings.json', 'utf8')) as Array<Record<string, unknown>>;
    // Only the runner's own defaults ship; personal bindings come from the host's private directory.
    expect(keybindings).toHaveLength(62);
    for (const personal of ['editor.fontFamily', 'editor.fontSize', 'workbench.sideBar.location', 'workbench.activityBar.location']) expect(settings).not.toHaveProperty(personal);
    expect(keybindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'ctrl+alt+up', command: 'editor.action.moveLinesUpAction' }),
      expect.objectContaining({ key: 'ctrl+alt+down', command: 'editor.action.moveLinesDownAction' }),
      expect.objectContaining({ key: 'alt+up', command: 'editor.action.moveLinesUpAction', when: 'editorTextFocus && !editorReadonly' }),
      expect.objectContaining({ key: 'alt+down', command: 'editor.action.moveLinesDownAction', when: 'editorTextFocus && !editorReadonly' }),
      expect.objectContaining({ key: 'ctrl+shift+cmd+right', command: 'editor.action.smartSelect.expand' }),
      expect.objectContaining({ key: 'ctrl+shift+cmd+left', command: 'editor.action.smartSelect.shrink' }),
      expect.objectContaining({ key: 'cmd+shift+r', command: 'editor.action.rename' }),
      expect.objectContaining({ key: 'ctrl+shift+g', command: 'interview-runner.viewSourceControl' }),
      expect.objectContaining({ key: 'ctrl+shift+e', command: 'interview-runner.viewExplorer' }),
      expect.objectContaining({ key: 'cmd+b', command: 'interview-runner.togglePrimarySidebar' }),
      expect.objectContaining({ key: 'cmd+alt+b', command: 'interview-runner.toggleSecondarySidebar' }),
      expect.objectContaining({ key: 'cmd+j', command: 'interview-runner.togglePanel' }),
      expect.objectContaining({ key: 'ctrl+alt+g g', command: 'workbench.scm.history.focus' }),
      expect.objectContaining({ key: 'f3', command: 'multiDiffEditor.goToNextChange', when: "activeEditor == 'multiDiffEditor'" }),
      expect.objectContaining({ key: 'shift+f3', command: 'multiDiffEditor.goToPreviousChange', when: "activeEditor == 'multiDiffEditor'" }),
      expect.objectContaining({ key: 'ctrl+alt+g f', command: 'multiDiffEditor.focusFileList', when: "activeEditor == 'multiDiffEditor'" }),
      expect.objectContaining({ key: 'alt+down', command: 'list.focusDown', when: "activeEditor == 'multiDiffEditor' && multiDiffEditorFileListFocus && listFocus" }),
      expect.objectContaining({ key: 'alt+up', command: 'list.focusUp', when: "activeEditor == 'multiDiffEditor' && multiDiffEditorFileListFocus && listFocus" }),
      expect.objectContaining({ key: 'f3', command: 'workbench.action.compareEditor.nextChange', when: "textCompareEditorVisible && activeEditor != 'multiDiffEditor'" }),
      expect.objectContaining({ key: 'shift+f3', command: 'workbench.action.compareEditor.previousChange', when: "textCompareEditorVisible && activeEditor != 'multiDiffEditor'" }),
    ]));
    for (let index = 1; index <= 8; index++) {
      expect(keybindings).toContainEqual(expect.objectContaining({ key: `cmd+${index}`, command: `workbench.action.openEditorAtIndex${index}` }));
      expect(keybindings).toContainEqual(expect.objectContaining({ key: `ctrl+${index}`, command: `workbench.action.openEditorAtIndex${index}` }));
    }
    expect(keybindings).toContainEqual(expect.objectContaining({ key: 'cmd+9', command: 'workbench.action.lastEditorInGroup' })); expect(keybindings).toContainEqual(expect.objectContaining({ key: 'ctrl+9', command: 'workbench.action.lastEditorInGroup' })); expect(keybindings).toContainEqual(expect.objectContaining({ key: 'cmd+1', command: '-workbench.action.focusFirstGroup' })); expect(keybindings).toContainEqual(expect.objectContaining({ key: 'cmd+9', command: '-workbench.action.focusNinthGroup' }));
    const entrypoint = await readFile('sandbox/entrypoint.sh', 'utf8'); expect(entrypoint).toContain("config --local user.name 'Interview Runner'"); expect(entrypoint).toContain("commit --allow-empty -qm 'Initial drill workspace'"); expect(entrypoint).toContain('--reconnection-grace-time 60');
  });

  it('installs no push hook: deployment is make upgrade, never a side effect of git push', async () => {
    expect((await readdir('.githooks').catch(() => [] as string[])).filter((name) => name !== 'pre-commit')).toEqual([]);
  });

  it('keeps sandbox UI state in the durable runner data volume', async () => {
    const compose = await readFile('compose.yaml', 'utf8'); expect(compose).toContain('SANDBOX_UI_STATE_DIR: /data/scratch/ui-state'); expect(compose.match(/RUNNER_DB_PATH: \/data\/\$\{DB_FILE\}/g)).toHaveLength(2); expect(compose.match(/- \$\{DB_DIR\}:\/data/g)).toHaveLength(2); expect(compose).toContain('name: ir-${STACK}-sandbox');
  });
});
