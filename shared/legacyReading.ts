// Reading drills are deprecated. A host that still serves some lists the frozen
// course → drill pairs in legacy-reading.json in its private directory
// (config.json's `private`, RUNNER_PRIVATE_DIR): {"<course-id>": ["<drill-id>"]}.
// The default is none. Hand-maintained; never extend automatically.
type LegacyReading = Readonly<Record<string, readonly string[]>>;
type NodeProcess = { env: Record<string, string | undefined>; getBuiltinModule?: (id: 'node:fs') => { readFileSync(path: string, encoding: 'utf8'): string } | undefined };
let legacyReading: LegacyReading | 'served' | undefined;

function load(): LegacyReading | 'served' {
  const node = (globalThis as { process?: NodeProcess }).process;
  const directory = node?.env?.RUNNER_PRIVATE_DIR; const fs = node?.getBuiltinModule?.('node:fs');
  // A browser cannot read the list. It only parses manifests the server has already filtered with it.
  if (!fs) return 'served';
  if (!directory) return {};
  const path = `${directory}/legacy-reading.json`;
  let text: string;
  try { text = fs.readFileSync(path, 'utf8'); } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return {}; throw error; }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((drills) => !Array.isArray(drills) || drills.some((drill) => typeof drill !== 'string'))) throw new Error(`${path} must map course ids to arrays of drill ids`);
  return value as LegacyReading;
}

export function isLegacyReading(courseId: string, drillId: string): boolean {
  legacyReading ??= load();
  if (legacyReading === 'served') return true;
  return Object.hasOwn(legacyReading, courseId) && legacyReading[courseId]!.includes(drillId);
}
