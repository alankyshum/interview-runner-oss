import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxHealth } from './sandboxTypes';

export async function extensionHostCrashes(userData: string): Promise<number | null> {
  try {
    const root = join(userData, 'logs'); const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const directory of directories) {
      try { const log = await readFile(join(root, directory, 'remoteagent.log'), 'utf8'); return (log.match(/Extension Host Process exited with code: null, signal:/g) ?? []).length; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Sandbox extension-host health unavailable', error); return null; }
}

export function cgroupHealth(output: string): Pick<SandboxHealth, 'oomKills' | 'memoryCurrent' | 'memoryPeak' | 'memoryMax'> {
  const lines = output.trim().split(/\r?\n/); const counters = lines.filter((line) => /^\d+$|^max$/.test(line)); const oom = lines.find((line) => /^oom_kill \d+$/.test(line));
  if (!oom || counters.length !== 3) return { oomKills: null, memoryCurrent: null, memoryPeak: null, memoryMax: null };
  const number = (value: string) => value === 'max' ? null : Number(value);
  return { oomKills: Number(oom.split(' ')[1]), memoryCurrent: number(counters[0]), memoryPeak: number(counters[1]), memoryMax: number(counters[2]) };
}
