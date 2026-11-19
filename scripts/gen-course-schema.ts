import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { COURSE_SCHEMA_VERSION } from '../shared/courseSchema';
import { schemaText } from '../shared/courseJsonSchema';

const dir = resolve(import.meta.dirname, '../schema');
await mkdir(dir, { recursive: true });
await writeFile(resolve(dir, `course.v${COURSE_SCHEMA_VERSION}.json`), schemaText());
