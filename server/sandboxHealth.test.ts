// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cgroupHealth, extensionHostCrashes } from './sandboxHealth';
import { commandFor } from './sandboxd';

describe('sandbox health', () => {
  it('parses cgroup counters and treats failed or incomplete reads as unknown', () => {
    expect(cgroupHealth('low 0\nhigh 0\nmax 9\noom 3\noom_kill 2\noom_group_kill 0\n100\n200\n300\n')).toEqual({ oomKills: 2, memoryCurrent: 100, memoryPeak: 200, memoryMax: 300 });
    expect(cgroupHealth('failure')).toEqual({ oomKills: null, memoryCurrent: null, memoryPeak: null, memoryMax: null });
    expect(commandFor({ action: 'health' })).toEqual(['cat', '/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory.max']);
    expect(() => commandFor({ action: 'health', args: ['anything'] })).toThrow('Invalid health arguments');
  });
  it('counts crashes only in the newest remote agent log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-health-'));
    try { expect(await extensionHostCrashes(root)).toBeNull(); for (const name of ['20260101', '20260102']) await mkdir(join(root, 'logs', name), { recursive: true }); await writeFile(join(root, 'logs/20260101/remoteagent.log'), 'Extension Host Process exited with code: null, signal: SIGKILL\n'); await writeFile(join(root, 'logs/20260102/remoteagent.log'), 'Extension Host Process exited with code: null, signal: SIGKILL\nExtension Host Process exited with code: null, signal: SIGTERM\n'); expect(await extensionHostCrashes(root)).toBe(2); } finally { await rm(root, { recursive: true, force: true }); }
  });
});
