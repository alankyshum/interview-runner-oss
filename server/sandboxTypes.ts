export type SandboxCreateSpec = {
  id: string;
  repoId: string;
  courseId: string;
  drillId: string;
  kind: 'coding' | 'ai-coding';
  workspacePath: string;
  sourcePath: string;
  testPath?: string;
  acceptancePath?: string;
  attemptNumber?: number;
  review?: boolean;
  contentRevision?: number;
};

export type SandboxRecord = {
  id: string;
  courseId: string;
  drillId: string;
  status: 'starting' | 'running' | 'stopped';
  target: string;
  workspace: string;
  kind: SandboxCreateSpec['kind'];
  lastSeen: number;
  containerId?: string;
  volume?: string;
  acceptance?: string;
  attemptNumber?: number;
  review?: boolean;
  contentRevision?: number;
};

export type SandboxHealth = { oomKills?: number | null; memoryCurrent?: number | null; memoryPeak?: number | null; memoryMax?: number | null; extHostCrashes: number | null };
export type SandboxExecAction = 'run' | 'capture-run' | 'workspace-files' | 'commit-files' | 'settings' | 'stage-commit' | 'health';
export type SandboxExecRequest = { action: SandboxExecAction; args?: string[]; runs?: string[][]; enabled?: boolean; stage?: number; commitTimestamp?: string; timeZone?: unknown };
