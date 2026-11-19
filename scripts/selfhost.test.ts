import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { derive, parseConfig } from './selfhost';

const base = { stack: 'home', port: 8081, content: { path: '/srv/courses' }, db: '/srv/ir/user.sqlite' };

describe('self-host config', () => {
  it('derives the host layout next to the user database', () => {
    expect(derive(parseConfig(base))).toEqual({
      STACK: 'home', PORT: '8081', OWNER: 'me', DB_DIR: '/srv/ir', DB_FILE: 'user.sqlite',
      CONTENT_MODE: 'path', CONTENT_DIR: '/srv/courses', CONTENT_GIT: '', CONTENT_REF: '',
      STATE_DIR: '/srv/ir/scratch', BACKUP_DIR: '/srv/ir/backups', PRIVATE_DIR: '/srv/ir/scratch/private',
    });
    expect(derive(parseConfig({ ...base, owner: 'ada', private: '/srv/private', content: { git: 'git@github.com:me/courses.git' } }))).toMatchObject({
      OWNER: 'ada', PRIVATE_DIR: '/srv/private', CONTENT_MODE: 'git', CONTENT_DIR: '/srv/ir/content', CONTENT_GIT: 'git@github.com:me/courses.git', CONTENT_REF: 'main',
    });
  });

  it('resolves the shipped example against the directory of config.json', () => {
    expect(derive(parseConfig(JSON.parse(readFileSync('config.example.json', 'utf8')), '/home/me/interview-runner'))).toMatchObject({
      STACK: 'interview-runner', OWNER: 'me', CONTENT_MODE: 'path', CONTENT_DIR: '/home/me/interview-runner/sample-content',
      DB_DIR: '/home/me/interview-runner/data', DB_FILE: 'user.sqlite',
    });
  });

  it.each([
    [{ ...base, stack: 'Home' }, 'stack'],
    [{ ...base, port: 0 }, 'port'],
    [{ ...base, db: 'user.sqlite' }, 'db'],
    [{ ...base, db: './data/user.sqlite' }, 'relative'],
    [{ ...base, private: '/srv/my private' }, 'private'],
    [{ ...base, db: '/srv/my data/user.sqlite' }, 'db'],
    [{ ...base, db: '/srv/ir/$(id).sqlite' }, 'db'],
    [{ ...base, db: '/srv/ir/content.db' }, 'content.db'],
    [{ ...base, db: '/user.sqlite' }, 'directory'],
    [{ ...base, content: { path: '/srv/../etc' } }, 'content.path'],
    [{ ...base, content: { path: '/srv/courses', git: 'x' } }, 'unknown key'],
    [{ ...base, content: { git: 'https://user:token@example.com/r.git' } }, 'credentials'],
    [{ ...base, content: { git: 'https://example.com/r.git', ref: '--upload-pack=x' } }, 'content.ref'],
    [{ ...base, token: 'secret' }, 'unknown key'],
  ])('rejects %j', (config, message) => {
    expect(() => derive(parseConfig(config))).toThrow(message);
  });
});
