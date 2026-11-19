import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { courseRepos, packageRoot } from '../server/courseRepos';
import { loadCourses } from '../server/courses';

for (const cwd of [packageRoot, ...courseRepos.map((repo) => repo.root)]) {
  const result = spawnSync(join(packageRoot, 'node_modules/.bin/tsc'), ['--noEmit'], { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const repo of courseRepos) {
  const courses = await loadCourses(join(repo.root, 'courses'));
  for (const drill of courses.flatMap((course) => course.chapters.flatMap((chapter) => chapter.drills))) {
    if (drill.contentType !== 'ai-coding' || drill.testRunner !== 'vitest') continue;
    const cwd = join(repo.root, drill.workspacePath);
    const result = spawnSync(join(packageRoot, 'node_modules/.bin/tsc'), ['--noEmit', '-p', 'tsconfig.json'], { cwd, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
